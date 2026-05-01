// api.js — LexFlow Kenya API client
// Place this in the same directory as App.jsx

const BASE = "http://localhost:5000";

export const getStoredToken = () => {
  try {
    const session = JSON.parse(localStorage.getItem("lexflowSession") || "null");
    return session?.token || localStorage.getItem("lexflowToken") || "";
  } catch {
    return localStorage.getItem("lexflowToken") || "";
  }
};

async function req(method, path, body) {
  const token = getStoredToken();
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem("lexflowSession");
    localStorage.removeItem("lexflowToken");
    window.dispatchEvent(new Event("lexflow:unauthorized"));
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const apiUrl = (path) => {
  const token = getStoredToken();
  if (!token || !path.startsWith("/api/")) return `${BASE}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE}${path}${sep}token=${encodeURIComponent(token)}`;
};
export const login = (body) => req("POST", "/api/auth/login", body);
export const register = (body) => req("POST", "/api/auth/register", body);
export const getCurrentUser = () => req("GET", "/api/auth/me");
export const getUsers = () => req("GET", "/api/auth/users");
export const deleteUser = (id) => req("DELETE", `/api/auth/users/${id}`);
export const globalSearch = (q) => req("GET", `/api/search?q=${encodeURIComponent(q)}`);

async function uploadReq(path, file) {
  const token = getStoredToken();
  const buffer = await file.arrayBuffer();
  const headers = {
    "Content-Type": file.type || "application/octet-stream",
    "X-File-Name": encodeURIComponent(file.name),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: buffer,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem("lexflowSession");
    localStorage.removeItem("lexflowToken");
    window.dispatchEvent(new Event("lexflow:unauthorized"));
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Clients ───
export const getClients = () => req("GET", "/api/clients");
export const createClient = (body) => req("POST", "/api/clients", body);

// ─── Matters ───
export const getMatters = () => req("GET", "/api/matters");
export const getMatter = (id) => req("GET", `/api/matters/${id}`);
export const createMatter = (body) => req("POST", "/api/matters", body);
export const updateMatterStatus = (id, body) => req("PATCH", `/api/matters/${id}/status`, body);

// ─── Tasks ───
export const getTasks = () => req("GET", "/api/tasks");
export const createTask = (body) => req("POST", "/api/tasks", body);
export const updateTask = (id, body) => req("PATCH", `/api/tasks/${id}`, body);

// ─── Time Entries ───
export const getTimeEntries = (matterId) =>
  req("GET", matterId ? `/api/time-entries?matter_id=${matterId}` : "/api/time-entries");
export const createTimeEntry = (body) => req("POST", "/api/time-entries", body);
export const updateTimeEntry = (id, body) => req("PATCH", `/api/time-entries/${id}`, body);

// ─── Appearances ───
export const getUpcomingAppearances = () => req("GET", "/api/appearances/upcoming");
export const createAppearance = (body) => req("POST", "/api/appearances", body);

// ─── Dashboard ───
export const getDashboard = () => req("GET", "/api/dashboard");

// ─── Case Notes ───
export const getCaseNotes = (matterId) => req("GET", `/api/matters/${matterId}/notes`);
export const createCaseNote = (matterId, body) => req("POST", `/api/matters/${matterId}/notes`, body);

// ─── Invoices ───
export const getInvoices = () => req("GET", "/api/invoices");
export const generateInvoice = (matterId, dueDate) => {
  const body = typeof matterId === "object" ? matterId : { matterId, dueDate };
  return req("POST", "/api/invoices/generate", body);
};
export const getInvoice = (id) => req("GET", `/api/invoices/${id}`);
export const updateInvoiceStatus = (id, status) => req("PATCH", `/api/invoices/${id}/status`, { status });
export const getInvoicePdf = async (id) => {
  const token = getStoredToken();
  const res = await fetch(`${BASE}/api/invoices/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    localStorage.removeItem("lexflowSession");
    localStorage.removeItem("lexflowToken");
    window.dispatchEvent(new Event("lexflow:unauthorized"));
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.blob();
};
export const downloadInvoicePdf = async (id, filename = "invoice.pdf") => {
  const blob = await getInvoicePdf(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return blob;
};

// ─── Documents ───
export const uploadMatterDocument = (matterId, file) => uploadReq(`/api/matters/${matterId}/documents`, file);
export const deleteDocument = (id) => req("DELETE", `/api/documents/${id}`);

// ─── Auth & Integrations ───
export const sendMpesaStk = (body) => req("POST", "/api/mpesa/stk-push", body);
export const sendWhatsAppReminders = (body) => req("POST", "/api/whatsapp/reminders", body);
