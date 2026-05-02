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

export function clearSession() {
  localStorage.removeItem('lexflowSession');
  localStorage.removeItem('lexflowToken');
  localStorage.removeItem('token');
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

