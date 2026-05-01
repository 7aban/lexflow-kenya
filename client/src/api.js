const BASE = 'http://localhost:5000';

export const getStoredToken = () => {
  try {
    const session = JSON.parse(localStorage.getItem('lexflowSession') || 'null');
    return session?.token || localStorage.getItem('lexflowToken') || '';
  } catch {
    return localStorage.getItem('lexflowToken') || '';
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
    localStorage.removeItem('lexflowSession');
    localStorage.removeItem('lexflowToken');
    window.dispatchEvent(new Event('lexflow:unauthorized'));
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
export const register = body => req('POST', '/api/auth/register', body);
export const getCurrentUser = () => req('GET', '/api/auth/me');
export const getUsers = () => req('GET', '/api/auth/users');
export const deleteUser = id => req('DELETE', `/api/auth/users/${id}`);
export const globalSearch = q => req('GET', `/api/search?q=${encodeURIComponent(q)}`);

export const getClients = () => req('GET', '/api/clients');
export const createClient = body => req('POST', '/api/clients', body);

export const getMatters = () => req('GET', '/api/matters');
export const getMatter = id => req('GET', `/api/matters/${id}`);
export const createMatter = body => req('POST', '/api/matters', body);
export const updateMatterStatus = (id, body) => req('PATCH', `/api/matters/${id}`, body);

export const getTasks = () => req('GET', '/api/tasks');
export const createTask = body => req('POST', '/api/tasks', body);
export const updateTask = (id, body) => req('PATCH', `/api/tasks/${id}`, body);

export const getTimeEntries = matterId => req('GET', matterId ? `/api/time-entries?matter_id=${matterId}` : '/api/time-entries');
export const createTimeEntry = body => req('POST', '/api/time-entries', body);
export const updateTimeEntry = (id, body) => req('PATCH', `/api/time-entries/${id}`, body);

export const getUpcomingAppearances = () => req('GET', '/api/appearances/upcoming');
export const createAppearance = body => req('POST', '/api/appearances', body);

export const getDashboard = () => req('GET', '/api/dashboard');

export const getCaseNotes = matterId => req('GET', `/api/matters/${matterId}/notes`);
export const createCaseNote = (matterId, body) => req('POST', `/api/matters/${matterId}/notes`, body);

export const getInvoices = () => req('GET', '/api/invoices');
export const generateInvoice = (matterId, dueDate) => req('POST', '/api/invoices/generate', typeof matterId === 'object' ? matterId : { matterId, dueDate });
export const getInvoice = id => req('GET', `/api/invoices/${id}`);
export const updateInvoiceStatus = (id, status) => req('PATCH', `/api/invoices/${id}/status`, { status });
export const getInvoicePdf = async id => {
  const token = getStoredToken();
  const res = await fetch(`${BASE}/api/invoices/${id}/pdf`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    localStorage.removeItem('lexflowSession');
    localStorage.removeItem('lexflowToken');
    window.dispatchEvent(new Event('lexflow:unauthorized'));
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
