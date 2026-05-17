export const API_BASE = '/api';
export const AUTH_FAILURE_MESSAGE = 'Session expired. Please log in again.';

export function readSession() {
  try {
    const session = JSON.parse(localStorage.getItem('lexflowSession') || 'null');
    if (session?.token) return session;
    const token = localStorage.getItem('lexflowToken') || localStorage.getItem('token');
    return token ? { token, user: null } : null;
  } catch {
    const token = localStorage.getItem('lexflowToken') || localStorage.getItem('token');
    return token ? { token, user: null } : null;
  }
}

export function saveSession(session) {
  localStorage.setItem('lexflowSession', JSON.stringify(session));
  localStorage.setItem('lexflowToken', session.token);
  localStorage.setItem('token', session.token);
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
export const listInvoicePayments = invoiceId => api(`/invoices/${invoiceId}/payments`);
export const recordInvoicePayment = (invoiceId, payload) => api(`/invoices/${invoiceId}/payments`, { method: 'POST', body: payload });
export const paymentReceiptUrl = (invoiceId, paymentId) => `/api/invoices/${invoiceId}/payments/${paymentId}/receipt.pdf`;
export const downloadPaymentReceipt = (invoiceId, paymentId, receiptNumber) =>
  downloadWithAuth(paymentReceiptUrl(invoiceId, paymentId), `${receiptNumber || paymentId}.pdf`);
export const getInvitations = () => api('/invitations');
export const createInvitation = data => api('/invitations', { method: 'POST', body: data });
export const verifyInvitation = token => api(`/invitations/${token}`);
export const acceptInvitation = (token, data) => api(`/invitations/${token}/accept`, { method: 'POST', body: data });
export const getMatterFolders = matterId => api(`/matters/${matterId}/folders`);
export const createFolder = (matterId, data) => api(`/matters/${matterId}/folders`, { method: 'POST', body: data });
export const updateFolder = (folderId, data) => api(`/folders/${folderId}`, { method: 'PATCH', body: data });
export const deleteFolder = folderId => api(`/folders/${folderId}`, { method: 'DELETE' });
export const getMatterDocuments = (matterId, folderId = 'all') => api(`/matters/${matterId}/documents${folderId && folderId !== 'all' ? `?folderId=${encodeURIComponent(folderId)}` : ''}`);
export const moveDocument = (docId, folderId) => api(`/documents/${docId}`, { method: 'PATCH', body: { folderId } });
export const updateDocument = (docId, data) => api(`/documents/${docId}`, { method: 'PATCH', body: data });
export const getClientActivity = (clientId, limit = 100) => api(`/clients/${clientId}/activity?limit=${encodeURIComponent(limit)}`);
export const updateReminderTemplate = (id, data) => api(`/reminder-templates/${id}`, { method: 'PUT', body: data });
export const getReminderLogs = (limit = 100) => api(`/reminder-logs?limit=${encodeURIComponent(limit)}`);

