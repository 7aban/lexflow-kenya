const BASE = '';
const AUTH_FAILURE_MESSAGE = 'Session expired. Please log in again.';

const clearAuthStorage = () => {
  localStorage.removeItem('lexflowSession');
  localStorage.removeItem('lexflowToken');
  localStorage.removeItem('token');
};

const notifyAuthFailure = () => {
  window.dispatchEvent(new CustomEvent('lexflow:auth-failure', {
    detail: { message: AUTH_FAILURE_MESSAGE },
  }));
  window.dispatchEvent(new Event('lexflow:unauthorized'));
};

const authExpiredError = () => {
  const error = new Error(AUTH_FAILURE_MESSAGE);
  error.isAuthExpired = true;
  return error;
};

export const getStoredToken = () => {
  try {
    const session = JSON.parse(localStorage.getItem('lexflowSession') || 'null');
    return session?.token || localStorage.getItem('lexflowToken') || localStorage.getItem('token') || '';
  } catch {
    return localStorage.getItem('lexflowToken') || localStorage.getItem('token') || '';
  }
};

async function req(method, path, body) {
  const token = getStoredToken();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearAuthStorage();
    notifyAuthFailure();
    throw authExpiredError();
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const apiUrl = (path) => {
  const token = getStoredToken();
  if (!token || !path.startsWith('/api/')) return `${BASE}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${BASE}${path}${sep}token=${encodeURIComponent(token)}`;
};

const fileToDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('Could not read file'));
  reader.readAsDataURL(file);
});

export const login = body => req('POST', '/api/auth/login', body);
export const clientLogin = body => req('POST', '/api/auth/client-login', body);
export const register = body => req('POST', '/api/auth/register', body);
export const getCurrentUser = () => req('GET', '/api/auth/me');
export const getUsers = () => req('GET', '/api/auth/users');
export const deleteUser = id => req('DELETE', `/api/auth/users/${id}`);
export const globalSearch = q => req('GET', `/api/search?q=${encodeURIComponent(q)}`);
export const getFirmSettings = () => req('GET', '/api/firm-settings');
export const updateFirmSettings = data => req('PUT', '/api/firm-settings', data);
export const getClientDashboard = () => req('GET', '/api/client/dashboard');

export const getClients = () => req('GET', '/api/clients');
export const createClient = body => req('POST', '/api/clients', body);
export const updateClient = (id, body) => req('PATCH', `/api/clients/${id}`, body);
export const deleteClient = id => req('DELETE', `/api/clients/${id}`);

export const getMatters = () => req('GET', '/api/matters');
export const getMatter = id => req('GET', `/api/matters/${id}`);
export const createMatter = body => req('POST', '/api/matters', body);
export const updateMatter = (id, body) => req('PATCH', `/api/matters/${id}`, body);
export const updateMatterStatus = (id, body) => req('PATCH', `/api/matters/${id}/status`, body);
export const deleteMatter = id => req('DELETE', `/api/matters/${id}`);

export const getTasks = () => req('GET', '/api/tasks');
export const createTask = body => req('POST', '/api/tasks', body);
export const updateTask = (id, body) => req('PATCH', `/api/tasks/${id}`, body);
export const deleteTask = id => req('DELETE', `/api/tasks/${id}`);

export const getTimeEntries = matterId => req('GET', matterId ? `/api/time-entries?matter_id=${matterId}` : '/api/time-entries');
export const createTimeEntry = body => req('POST', '/api/time-entries', body);
export const updateTimeEntry = (id, body) => req('PATCH', `/api/time-entries/${id}`, body);
export const deleteTimeEntry = id => req('DELETE', `/api/time-entries/${id}`);

export const getUpcomingAppearances = () => req('GET', '/api/appearances/upcoming');
export const createAppearance = body => req('POST', '/api/appearances', body);
export const updateAppearance = (id, body) => req('PATCH', `/api/appearances/${id}`, body);
export const deleteAppearance = id => req('DELETE', `/api/appearances/${id}`);

export const getDashboard = () => req('GET', '/api/dashboard');

export const getCaseNotes = matterId => req('GET', `/api/matters/${matterId}/notes`);
export const createCaseNote = (matterId, body) => req('POST', `/api/matters/${matterId}/notes`, body);

export const getInvoices = () => req('GET', '/api/invoices');
export const generateInvoice = (matterId, dueDate) => req('POST', '/api/invoices/generate', typeof matterId === 'object' ? matterId : { matterId, dueDate });
export const getInvoice = id => req('GET', `/api/invoices/${id}`);
export const updateInvoiceStatus = (id, status) => req('PATCH', `/api/invoices/${id}/status`, { status });
export const deleteInvoice = id => req('DELETE', `/api/invoices/${id}`);
export const getInvoicePdf = async id => {
  const token = getStoredToken();
  const res = await fetch(`${BASE}/api/invoices/${id}/pdf`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    clearAuthStorage();
    notifyAuthFailure();
    throw authExpiredError();
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.blob();
};
export const downloadInvoicePdf = async (id, filename = 'invoice.pdf') => {
  const blob = await getInvoicePdf(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return blob;
};

export const uploadMatterDocument = async (matterId, file) => req('POST', `/api/matters/${matterId}/documents`, {
  name: file.name,
  mimeType: file.type || 'application/octet-stream',
  data: await fileToDataUrl(file),
});
export const deleteDocument = id => req('DELETE', `/api/documents/${id}`);

export const sendMpesaStk = body => req('POST', '/api/mpesa/stk-push', body);
export const sendWhatsAppReminders = body => req('POST', '/api/whatsapp/reminders', body);
