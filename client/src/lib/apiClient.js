export const API_BASE = '/api';
export const AUTH_FAILURE_MESSAGE = 'Session expired. Please log in again.';

// SEC-UX-AUDIT-1: one-time migration off the legacy generic 'token' key.
// Adopt a legacy generic token only when no LexFlow token exists yet, then
// always drop the generic key so it is never treated as a continuing source.
function migrateLegacyToken() {
  try {
    const legacy = localStorage.getItem('token');
    if (!legacy) return;
    if (!localStorage.getItem('lexflowToken') && !localStorage.getItem('lexflowSession')) {
      localStorage.setItem('lexflowToken', legacy);
    }
    localStorage.removeItem('token');
  } catch {
    // localStorage may be unavailable; ignore.
  }
}

export function readSession() {
  migrateLegacyToken();
  try {
    const session = JSON.parse(localStorage.getItem('lexflowSession') || 'null');
    if (session?.token) return session;
    const token = localStorage.getItem('lexflowToken');
    return token ? { token, user: null } : null;
  } catch {
    const token = localStorage.getItem('lexflowToken');
    return token ? { token, user: null } : null;
  }
}

export function saveSession(session) {
  localStorage.setItem('lexflowSession', JSON.stringify(session));
  localStorage.setItem('lexflowToken', session.token);
  // SEC-UX-AUDIT-1: never persist the legacy generic 'token'; clean up any stale copy.
  localStorage.removeItem('token');
}

export async function exchangeOAuthCode(code) {
  const res = await fetch(`${API_BASE}/auth/oauth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'OAuth exchange failed');
  return data;
}

export function clearSession() {
  localStorage.removeItem('lexflowSession');
  localStorage.removeItem('lexflowToken');
  localStorage.removeItem('token');
}

const LEXFLOW_KEY_PREFIX = 'lexflow';
const LEXFLOW_CACHE_PREFIX = 'lexflow-';

const LEXFLOW_STORAGE_KEYS = [
  'lexflowSession',
  'lexflowToken',
  'token',
  'lexflow:v1:staff:openNavGroups',
  'lexflowOpenNavGroups',
];

export async function clearAllLexFlowStorage() {
  for (const key of LEXFLOW_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }

  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && key.toLowerCase().startsWith(LEXFLOW_KEY_PREFIX.toLowerCase())) {
      localStorage.removeItem(key);
    }
  }

  try {
    if ('caches' in window) {
      const cacheKeys = await caches.keys();
      for (const key of cacheKeys) {
        if (key.startsWith(LEXFLOW_CACHE_PREFIX)) {
          await caches.delete(key);
        }
      }
    }
  } catch {
    // Cache API may be restricted; continue without failing
  }

  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.active) {
        registration.active.postMessage({ type: 'LEXFLOW_LOGOUT_CLEAR' });
      }
    }
  } catch {
    // SW messaging may be restricted; continue without failing
  }
}

function emitAuthFailure() {
  window.dispatchEvent(new CustomEvent('lexflow:auth-failure', {
    detail: { message: AUTH_FAILURE_MESSAGE },
  }));
}

class AuthExpiredError extends Error {
  constructor() {
    super(AUTH_FAILURE_MESSAGE);
    this.name = 'AuthExpiredError';
    this.isAuthExpired = true;
  }
}

export async function api(path, options = {}) {
  const session = readSession();
  const headers = { ...(options.headers || {}) };
  const isFormData = options.body instanceof FormData;
  if (!isFormData) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body && !isFormData ? JSON.stringify(options.body) : options.body,
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
  if (response.status === 401) {
    clearSession();
    emitAuthFailure();
    throw new AuthExpiredError();
  }
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function filenameFromDisposition(disposition, fallbackFilename) {
  const match =
    disposition.match(/filename\*=UTF-8''([^;]+)/i) ||
    disposition.match(/filename="?([^";]+)"?/i);
  if (!match) return fallbackFilename;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1] || fallbackFilename;
  }
}

export async function downloadWithAuth(path, fallbackFilename = 'download') {
  const session = readSession();
  if (!session?.token) throw new AuthExpiredError();

  const response = await fetch(path, {
    headers: {
      Authorization: `Bearer ${session.token}`,
    },
  });

  if (response.status === 401) {
    clearSession();
    emitAuthFailure();
    throw new AuthExpiredError();
  }
  if (!response.ok) {
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text().catch(() => '');
    throw new Error(body?.error || body || `Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get('Content-Disposition') || '', fallbackFilename);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return blob;
}

export async function postDownloadWithAuth(path, body = {}, fallbackFilename = 'download') {
  const session = readSession();
  if (!session?.token) throw new AuthExpiredError();

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    clearSession();
    emitAuthFailure();
    throw new AuthExpiredError();
  }
  if (!response.ok) {
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text().catch(() => '');
    throw new Error(payload?.error || payload || `Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get('Content-Disposition') || '', fallbackFilename);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return blob;
}

// PRODUCT-27C: fetch a document's raw bytes (no browser download) so PDF.js can
// render it client-side for click-to-place stamping. Uses the same Bearer-token
// pattern as the other authenticated fetch helpers and returns an ArrayBuffer.
export async function fetchDocumentArrayBuffer(documentId) {
  const session = readSession();
  if (!session?.token) throw new AuthExpiredError();

  const response = await fetch(`${API_BASE}/documents/${encodeURIComponent(documentId)}/download`, {
    headers: {
      Authorization: `Bearer ${session.token}`,
    },
  });

  if (response.status === 401) {
    clearSession();
    emitAuthFailure();
    throw new AuthExpiredError();
  }
  if (!response.ok) {
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json().catch(() => ({})) : await response.text().catch(() => '');
    throw new Error(body?.error || body || `Document fetch failed (${response.status})`);
  }

  return response.arrayBuffer();
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
}

export function getAuditLogs(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return api(`/audit-logs${suffix}`);
}

export function getAuditEvents(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return api(`/audit-events${suffix}`);
}

function queryPath(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return `${path}${suffix}`;
}

export const getDeadlines = (params = {}) => api(queryPath('/deadlines', params));
export const createDeadline = data => api('/deadlines', { method: 'POST', body: data });
export const updateDeadline = (id, data) => api(`/deadlines/${id}`, { method: 'PATCH', body: data });
export const deleteDeadline = id => api(`/deadlines/${id}`, { method: 'DELETE' });
export const getComplianceGuidance = () => api('/compliance-guidance');
export const getNotifications = () => api('/notifications');
export const markNotificationsRead = data => api('/notifications/read', { method: 'POST', body: data });
export const getHrStaff = () => api('/hr/staff');
export const getHrStaffProfile = userId => api(`/hr/staff/${encodeURIComponent(userId)}/profile`);
export const createHrStaffProfile = (userId, payload) => api(`/hr/staff/${encodeURIComponent(userId)}/profile`, { method: 'POST', body: payload });
export const updateHrStaffProfile = (userId, payload) => api(`/hr/staff/${encodeURIComponent(userId)}/profile`, { method: 'PATCH', body: payload });
export const listConnectedAccounts = () => api('/connected-accounts');
export const startConnectedAccountOAuth = provider => api(`/connected-accounts/${encodeURIComponent(provider)}/start`, { method: 'POST', body: {} });
export const disconnectConnectedAccount = id => api(`/connected-accounts/${encodeURIComponent(id)}/disconnect`, { method: 'POST', body: {} });
export const syncConnectedAccountEmailMetadata = id => api(`/connected-accounts/${encodeURIComponent(id)}/sync-email-metadata`, { method: 'POST', body: {} });
export const syncConnectedAccountCalendarMetadata = id => api(`/connected-accounts/${encodeURIComponent(id)}/sync-calendar-metadata`, { method: 'POST', body: {} });
export const getWorkEmailMessages = (filters = {}) => api(queryPath('/work-email/messages', filters));
export const getWorkEmailMessageMatches = id => api(`/work-email/messages/${encodeURIComponent(id)}/matches`);
export const confirmWorkEmailMatter = (messageId, matterId) => api(`/work-email/messages/${encodeURIComponent(messageId)}/confirm-matter`, { method: 'POST', body: matterId ? { matterId } : {} });
export const unlinkWorkEmailMatter = messageId => api(`/work-email/messages/${encodeURIComponent(messageId)}/unlink-matter`, { method: 'POST', body: {} });
export const getMatterWorkMetadataLinks = matterId => api(`/matters/${encodeURIComponent(matterId)}/work-metadata-links`);
export const getWorkCalendarEvents = (filters = {}) => api(queryPath('/work-calendar/events', filters));
export const getWorkCalendarEventMatches = id => api(`/work-calendar/events/${encodeURIComponent(id)}/matches`);
export const confirmWorkCalendarMatter = (eventId, matterId) => api(`/work-calendar/events/${encodeURIComponent(eventId)}/confirm-matter`, { method: 'POST', body: matterId ? { matterId } : {} });
export const unlinkWorkCalendarMatter = eventId => api(`/work-calendar/events/${encodeURIComponent(eventId)}/unlink-matter`, { method: 'POST', body: {} });
export const getConversations = (params = {}) => api(queryPath('/conversations', params));
export const createConversation = data => api('/conversations', { method: 'POST', body: data });
export const getConversationMessages = conversationId => api(`/conversations/${conversationId}/messages`);
export const sendConversationMessage = (conversationId, data) => api(`/conversations/${conversationId}/messages`, { method: 'POST', body: data });
export const markConversationRead = conversationId => api(`/conversations/${conversationId}/read`, { method: 'POST', body: {} });
export const updateConversationStatus = (conversationId, status) => api(`/conversations/${conversationId}/status`, { method: 'PATCH', body: { status } });
export const getAdvocatePerformance = (refresh = false) => api(`/performance/advocates${refresh ? '?refresh=1' : ''}`);
export const getAdvocatePerformanceDetail = (userId, refresh = false) => api(`/performance/advocates/${userId}${refresh ? '?refresh=1' : ''}`);
export const getNotices = () => api('/notices');
export const createNotice = data => api('/notices', { method: 'POST', body: data });
export const deleteNotice = id => api(`/notices/${id}`, { method: 'DELETE' });
export const uploadPaymentProof = data => api('/payment-proofs', { method: 'POST', body: data });
export const getInvoiceDetails = invoiceId => api(`/invoices/${invoiceId}`);
export const listInvoicePayments = invoiceId => api(`/invoices/${invoiceId}/payments`);
export const recordInvoicePayment = (invoiceId, payload) => api(`/invoices/${invoiceId}/payments`, { method: 'POST', body: payload });
export const paymentReceiptUrl = (invoiceId, paymentId) => `/api/invoices/${invoiceId}/payments/${paymentId}/receipt.pdf`;
export const downloadPaymentReceipt = (invoiceId, paymentId, receiptNumber) =>
  downloadWithAuth(paymentReceiptUrl(invoiceId, paymentId), `${receiptNumber || paymentId}.pdf`);
export const getInvitations = () => api('/invitations');
export const createInvitation = data => api('/invitations', { method: 'POST', body: data });
export const verifyInvitation = token => api(`/invitations/${token}`);
export const acceptInvitation = (token, data) => api(`/invitations/${token}/accept`, { method: 'POST', body: data });
export const listMatterChecklistItems = matterId => api(`/matters/${matterId}/checklist-items`);
export const createMatterChecklistItem = (matterId, payload) => api(`/matters/${matterId}/checklist-items`, { method: 'POST', body: payload });
export const updateMatterChecklistItem = (matterId, itemId, payload) => api(`/matters/${matterId}/checklist-items/${itemId}`, { method: 'PATCH', body: payload });
export const deleteMatterChecklistItem = (matterId, itemId) => api(`/matters/${matterId}/checklist-items/${itemId}`, { method: 'DELETE' });
export const listChecklistTemplates = () => api('/checklist-templates');
export const createChecklistTemplate = payload => api('/checklist-templates', { method: 'POST', body: payload });
export const updateChecklistTemplate = (templateId, payload) => api(`/checklist-templates/${templateId}`, { method: 'PATCH', body: payload });
export const deleteChecklistTemplate = templateId => api(`/checklist-templates/${templateId}`, { method: 'DELETE' });
export const applyChecklistTemplate = (matterId, templateId) => api(`/matters/${matterId}/checklist-template-applications`, { method: 'POST', body: { templateId } });
export const getMatterFolders = matterId => api(`/matters/${matterId}/folders`);
export const createFolder = (matterId, data) => api(`/matters/${matterId}/folders`, { method: 'POST', body: data });
export const updateFolder = (folderId, data) => api(`/folders/${folderId}`, { method: 'PATCH', body: data });
export const deleteFolder = folderId => api(`/folders/${folderId}`, { method: 'DELETE' });
export const getMatterDocuments = (matterId, folderId = 'all') => api(`/matters/${matterId}/documents${folderId && folderId !== 'all' ? `?folderId=${encodeURIComponent(folderId)}` : ''}`);
export const listDocumentTemplates = () => api('/document-templates');
export const generateDocumentFromTemplate = (matterId, templateId) =>
  api(`/matters/${matterId}/document-templates/${templateId}/generate`, {
    method: 'POST',
    body: {},
  });
export const previewDocumentTemplate = (matterId, templateId) =>
  api(`/matters/${matterId}/document-templates/${templateId}/preview`, {
    method: 'POST',
    body: {},
  });
export const mergePdfDocuments = (documentIds, filename) =>
  postDownloadWithAuth('/document-tools/merge-pdfs', { documentIds, filename }, filename || 'merged-document.pdf');
export const saveMergedPdf = (documentIds, filename, matterId) =>
  api('/document-tools/merge-pdfs/save', {
    method: 'POST',
    body: { matterId, documentIds, filename, clientVisible: false },
  });
export const rotatePdfDocument = (documentId, degrees, filename) =>
  postDownloadWithAuth('/document-tools/rotate-pdf', { documentId, degrees, filename }, filename || 'rotated-document.pdf');
export const saveRotatedPdf = (documentId, degrees, filename, matterId) =>
  api('/document-tools/rotate-pdf/save', {
    method: 'POST',
    body: { matterId, documentId, degrees, filename, clientVisible: false },
  });
export const extractPdfPages = (documentId, ranges, filename) =>
  postDownloadWithAuth('/document-tools/extract-pdf-pages', { documentId, ranges, filename }, filename || 'extracted-pages.pdf');
export const saveExtractedPdf = (documentId, ranges, filename, matterId) =>
  api('/document-tools/extract-pdf-pages/save', {
    method: 'POST',
    body: { matterId, documentId, ranges, filename, clientVisible: false },
  });
export const splitPdfPages = (documentId, order, filename) =>
  postDownloadWithAuth('/document-tools/split-pdf', { documentId, order, filename }, filename || 'reordered-pages.pdf');
export const saveSplitPdf = (documentId, order, filename, matterId) =>
  api('/document-tools/split-pdf/save', {
    method: 'POST',
    body: { matterId, documentId, order, filename, clientVisible: false },
  });
export const imagesToPdf = (documentIds, filename, pageSize) =>
  postDownloadWithAuth('/document-tools/images-to-pdf', { documentIds, filename, pageSize }, filename || 'images.pdf');
export const saveImagesToPdf = (documentIds, filename, pageSize, matterId) =>
  api('/document-tools/images-to-pdf/save', {
    method: 'POST',
    body: { matterId, documentIds, filename, pageSize, clientVisible: false },
  });
export const deletePdfPages = (documentId, pages, filename) =>
  postDownloadWithAuth('/document-tools/delete-pdf-pages', { documentId, pages, filename }, filename || 'pages-removed.pdf');
export const saveDeletedPdf = (documentId, pages, filename, matterId) =>
  api('/document-tools/delete-pdf-pages/save', {
    method: 'POST',
    body: { matterId, documentId, pages, filename, clientVisible: false },
  });
export const numberPdfPages = (documentId, startNumber, position, filename) =>
  postDownloadWithAuth('/document-tools/number-pdf-pages', { documentId, startNumber, position, filename }, filename || 'paginated-document.pdf');
export const saveNumberedPdf = (documentId, startNumber, position, filename, matterId) =>
  api('/document-tools/number-pdf-pages/save', {
    method: 'POST',
    body: { matterId, documentId, startNumber, position, filename, clientVisible: false },
  });
export const createCourtBundle = (matterId, documentIds, filename, paginate, startNumber, position, includeIndex, documentLabels, includeCover, cover, includeDividers, dividerLabels, includeBookmarks, includeCertificate) =>
  postDownloadWithAuth('/document-tools/court-bundle', { matterId, documentIds, filename, paginate, startNumber, position, includeIndex, documentLabels, ...(includeCover ? { includeCover: true, cover } : {}), ...(includeDividers ? { includeDividers: true, dividerLabels: dividerLabels || {} } : {}), ...(includeBookmarks ? { includeBookmarks: true } : {}), ...(includeCertificate ? { includeCertificate: true } : {}) }, filename || 'court-bundle.pdf');
export const saveCourtBundle = (matterId, documentIds, filename, paginate, startNumber, position, includeIndex, documentLabels, includeCover, cover, includeDividers, dividerLabels, includeBookmarks, includeCertificate) =>
  api('/document-tools/court-bundle/save', {
    method: 'POST',
    body: { matterId, documentIds, filename, paginate, startNumber, position, includeIndex, documentLabels, ...(includeCover ? { includeCover: true, cover } : {}), ...(includeDividers ? { includeDividers: true, dividerLabels: dividerLabels || {} } : {}), ...(includeBookmarks ? { includeBookmarks: true } : {}), ...(includeCertificate ? { includeCertificate: true } : {}) },
  });
export const stampPdf = (documentId, assetId, pageNumber, x, y, width, filename) =>
  postDownloadWithAuth('/document-tools/stamp-pdf', { documentId, assetId, pageNumber, x, y, width, filename }, filename || 'stamped-document.pdf');
export const saveStampedPdf = (matterId, documentId, assetId, pageNumber, x, y, width, filename) =>
  api('/document-tools/stamp-pdf/save', {
    method: 'POST',
    body: { matterId, documentId, assetId, pageNumber, x, y, width, filename, clientVisible: false },
  });
export const tenthLinePdf = (documentId, startNumber, filename) =>
  postDownloadWithAuth('/document-tools/tenth-line', { documentId, startNumber, filename }, filename || 'tenth-lined-document.pdf');
export const saveTenthLinedPdf = (documentId, startNumber, filename, matterId) =>
  api('/document-tools/tenth-line/save', {
    method: 'POST',
    body: { matterId, documentId, startNumber, filename, clientVisible: false },
  });
export const moveDocument = (docId, folderId) => api(`/documents/${docId}`, { method: 'PATCH', body: { folderId } });
export const updateDocument = (docId, data) => api(`/documents/${docId}`, { method: 'PATCH', body: data });
export const getClientActivity = (clientId, limit = 100) => api(`/clients/${clientId}/activity?limit=${encodeURIComponent(limit)}`);
export const updateReminderTemplate = (id, data) => api(`/reminder-templates/${id}`, { method: 'PUT', body: data });
export const getReminderLogs = (limit = 100) => api(`/reminder-logs?limit=${encodeURIComponent(limit)}`);

export const uploadUserAvatar = (userId, data, mimeType) =>
  api(`/users/${userId}/avatar`, { method: 'POST', body: { data, mimeType } });
export const deleteUserAvatar = (userId) =>
  api(`/users/${userId}/avatar`, { method: 'DELETE' });

async function fetchAvatarPathObjectUrl(path) {
  const session = readSession();
  if (!session?.token) return null;
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export async function fetchAvatarObjectUrl(userId) {
  return fetchAvatarPathObjectUrl(`/users/${userId}/avatar`);
}

export const getMyAvatar = () => fetchAvatarPathObjectUrl('/auth/me/avatar');
export const fetchMyAvatarObjectUrl = getMyAvatar;
export const uploadMyAvatar = (file) => {
  const body = new FormData();
  body.append('avatar', file);
  return api('/auth/me/avatar', { method: 'POST', body });
};
export const deleteMyAvatar = () => api('/auth/me/avatar', { method: 'DELETE' });

export const getClientAvatar = (clientId) => fetchAvatarPathObjectUrl(`/clients/${clientId}/avatar`);
export const fetchClientAvatarObjectUrl = getClientAvatar;
export const uploadClientAvatar = (clientId, file) => {
  const body = new FormData();
  body.append('avatar', file);
  return api(`/clients/${clientId}/avatar`, { method: 'POST', body });
};
export const deleteClientAvatar = (clientId) => api(`/clients/${clientId}/avatar`, { method: 'DELETE' });

export const getMessageAvatar = (conversationId, messageId) =>
  fetchAvatarPathObjectUrl(`/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/avatar`);

// HR Leave Requests
export const getHrLeaveRequests = (params = {}) => api(queryPath('/hr/leave-requests', params));
export const getHrLeaveRequest = id => api(`/hr/leave-requests/${encodeURIComponent(id)}`);
export const approveHrLeaveRequest = (id, payload) => api(`/hr/leave-requests/${encodeURIComponent(id)}/approve`, { method: 'PATCH', body: payload || {} });
export const rejectHrLeaveRequest = (id, payload) => api(`/hr/leave-requests/${encodeURIComponent(id)}/reject`, { method: 'PATCH', body: payload || {} });
export const cancelHrLeaveRequestAdmin = id => api(`/hr/leave-requests/${encodeURIComponent(id)}/cancel`, { method: 'PATCH', body: {} });
export const getMyLeaveRequests = () => api('/hr/me/leave-requests');
export const createMyLeaveRequest = payload => api('/hr/me/leave-requests', { method: 'POST', body: payload });
export const cancelMyLeaveRequest = id => api(`/hr/me/leave-requests/${encodeURIComponent(id)}/cancel`, { method: 'PATCH', body: {} });

// HR Leave Balances and Dashboard
export const getHrDashboard = (year) => api(queryPath('/hr/dashboard', { year }));
export const getHrLeaveBalances = (params = {}) => api(queryPath('/hr/leave-balances', params));
export const setHrLeaveEntitlement = (userId, leaveType, year, payload) =>
  api(`/hr/leave-entitlements/${encodeURIComponent(userId)}/${encodeURIComponent(leaveType)}/${encodeURIComponent(year)}`, { method: 'PUT', body: payload });
export const createHrLeaveBalanceAdjustment = (payload) =>
  api('/hr/leave-balance-adjustments', { method: 'POST', body: payload });
export const getMyLeaveBalances = (year) => api(queryPath('/hr/me/leave-balances', { year }));
