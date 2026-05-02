const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
const db = new sqlite3.Database(path.join(__dirname, 'lawfirm.db'));
const JWT_SECRET = process.env.JWT_SECRET || 'lexflow-kenya-secret';
const invitationAttempts = new Map();
let reminderJobsStarted = false;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function onRun(err) { err ? reject(err) : resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
const genId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const invoiceNumber = () => `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
const money = amount => `KSh ${Number(amount || 0).toLocaleString('en-KE')}`;
const defaultFirmSettings = {
  id: 'default',
  name: 'LexFlow Kenya',
  logo: '',
  primaryColor: '#0F1B33',
  accentColor: '#D4A34A',
  websiteURL: '',
  email: 'accounts@lexflow.co.ke',
  phone: '+254 700 123456',
  address: 'Nairobi, Kenya',
};
const defaultReminderSettings = {
  remindersEnabled: true,
  whatsappEnabled: false,
  emailEnabled: false,
  twilioSid: '',
  twilioToken: '',
  twilioFromNumber: '',
  smtpHost: '',
  smtpPort: '',
  smtpUser: '',
  smtpPass: '',
};
const defaultReminderTemplates = [
  {
    eventType: 'court_date_tomorrow',
    channel: 'whatsapp',
    subject: '',
    body: 'Good evening {{clientName}}. This is a courteous reminder from {{firmName}} that {{matterTitle}} is listed for court tomorrow, {{courtDate}}, at {{courtTime}}. For any urgent clarification, contact us on {{firmPhone}}.',
  },
  {
    eventType: 'court_date_tomorrow',
    channel: 'email',
    subject: 'Court reminder for {{matterTitle}}',
    body: 'Dear {{clientName}},\n\nThis is a courteous reminder that {{matterTitle}} is listed for court tomorrow, {{courtDate}}, at {{courtTime}}.\n\nPlease contact {{firmName}} on {{firmPhone}} if you require any clarification.\n\nKind regards,\n{{firmName}}',
  },
  {
    eventType: 'court_date_today',
    channel: 'whatsapp',
    subject: '',
    body: 'Good morning {{clientName}}. {{matterTitle}} is listed for court today, {{courtDate}}, at {{courtTime}}. {{firmName}} will keep you updated. For urgent assistance call {{firmPhone}}.',
  },
  {
    eventType: 'court_date_today',
    channel: 'email',
    subject: 'Court appearance today: {{matterTitle}}',
    body: 'Dear {{clientName}},\n\n{{matterTitle}} is listed for court today, {{courtDate}}, at {{courtTime}}.\n\nWe will keep you updated on progress. For urgent assistance, contact us on {{firmPhone}}.\n\nKind regards,\n{{firmName}}',
  },
  {
    eventType: 'invoice_overdue',
    channel: 'whatsapp',
    subject: '',
    body: 'Dear {{clientName}}, this is a polite reminder from {{firmName}} that an invoice for {{matterTitle}} of {{invoiceAmount}} due on {{invoiceDueDate}} is overdue. Kindly contact us on {{firmPhone}} if you need assistance.',
  },
  {
    eventType: 'invoice_overdue',
    channel: 'email',
    subject: 'Overdue invoice reminder - {{matterTitle}}',
    body: 'Dear {{clientName}},\n\nThis is a polite reminder that an invoice for {{matterTitle}} amounting to {{invoiceAmount}} and due on {{invoiceDueDate}} is overdue.\n\nKindly contact us on {{firmPhone}} if you need assistance or have already made payment.\n\nKind regards,\n{{firmName}}',
  },
  {
    eventType: 'invoice_outstanding',
    channel: 'whatsapp',
    subject: '',
    body: 'Dear {{clientName}}, this is a gentle reminder from {{firmName}} that your invoice for {{matterTitle}} of {{invoiceAmount}} is due on {{invoiceDueDate}}. Thank you.',
  },
  {
    eventType: 'invoice_outstanding',
    channel: 'email',
    subject: 'Upcoming invoice due date - {{matterTitle}}',
    body: 'Dear {{clientName}},\n\nThis is a gentle reminder that your invoice for {{matterTitle}} amounting to {{invoiceAmount}} is due on {{invoiceDueDate}}.\n\nThank you for your attention.\n\nKind regards,\n{{firmName}}',
  },
];

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some(existing => existing.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureClientUserSupport() {
  const schema = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
  if (schema?.sql && !schema.sql.includes("'client'")) {
    await run('ALTER TABLE users RENAME TO users_old');
    await run(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin','client')) DEFAULT 'assistant', clientId TEXT, createdAt TEXT)`);
    await run('INSERT INTO users (id,email,password,fullName,role,createdAt) SELECT id,email,password,fullName,role,createdAt FROM users_old');
    await run('DROP TABLE users_old');
  }
  await ensureColumn('users', 'clientId', 'TEXT');
}

async function getFirmSettings() {
  const settings = await get('SELECT * FROM firm_settings WHERE id=?', ['default']);
  const reminderSettings = await getReminderSettings();
  return { ...defaultFirmSettings, ...(settings || {}), reminderSettings };
}

async function getReminderSettings() {
  const settings = await get('SELECT * FROM reminder_settings WHERE id=?', ['default']).catch(() => null);
  const merged = { ...defaultReminderSettings, ...(settings || {}) };
  return {
    ...merged,
    remindersEnabled: Boolean(Number(merged.remindersEnabled)),
    whatsappEnabled: Boolean(Number(merged.whatsappEnabled)),
    emailEnabled: Boolean(Number(merged.emailEnabled)),
  };
}

async function saveReminderSettings(settings) {
  const merged = { ...defaultReminderSettings, ...settings, id: 'default' };
  await run(`INSERT INTO reminder_settings (id,remindersEnabled,whatsappEnabled,emailEnabled,twilioSid,twilioToken,twilioFromNumber,smtpHost,smtpPort,smtpUser,smtpPass)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET remindersEnabled=excluded.remindersEnabled, whatsappEnabled=excluded.whatsappEnabled, emailEnabled=excluded.emailEnabled, twilioSid=excluded.twilioSid, twilioToken=excluded.twilioToken, twilioFromNumber=excluded.twilioFromNumber, smtpHost=excluded.smtpHost, smtpPort=excluded.smtpPort, smtpUser=excluded.smtpUser, smtpPass=excluded.smtpPass`,
    ['default', merged.remindersEnabled ? 1 : 0, merged.whatsappEnabled ? 1 : 0, merged.emailEnabled ? 1 : 0, merged.twilioSid || '', merged.twilioToken || '', merged.twilioFromNumber || '', merged.smtpHost || '', merged.smtpPort || '', merged.smtpUser || '', merged.smtpPass || '']);
}

function templateKey(template) {
  return `${template.eventType}:${template.channel}`;
}

function defaultTemplateFor(eventType, channel) {
  return defaultReminderTemplates.find(t => t.eventType === eventType && t.channel === channel);
}

async function seedReminderTemplates() {
  for (const template of defaultReminderTemplates) {
    const existing = await get('SELECT id FROM reminder_templates WHERE eventType=? AND channel=?', [template.eventType, template.channel]);
    if (!existing) {
      await run('INSERT INTO reminder_templates (id,eventType,channel,subject,body,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)', [genId('RT'), template.eventType, template.channel, template.subject || '', template.body, 'system', new Date().toISOString()]);
    }
  }
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin','client')) DEFAULT 'assistant', clientId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'Individual', contact TEXT, email TEXT, phone TEXT, status TEXT DEFAULT 'Active', joinDate TEXT, conflictCleared INTEGER DEFAULT 0, retainer REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, reference TEXT UNIQUE, clientId TEXT NOT NULL, title TEXT NOT NULL, practiceArea TEXT, stage TEXT DEFAULT 'Intake', assignedTo TEXT, paralegal TEXT, openDate TEXT, description TEXT, court TEXT, judge TEXT, caseNo TEXT, opposingCounsel TEXT, billingRate REAL DEFAULT 0, retainerBalance REAL DEFAULT 0, totalBilled REAL DEFAULT 0, priority TEXT DEFAULT 'Medium', solDate TEXT, billingType TEXT DEFAULT 'hourly', fixedFee REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, assignee TEXT, dueDate TEXT, auto_generated INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS time_entries (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, attorney TEXT, date TEXT, hours REAL DEFAULT 0, activity TEXT, description TEXT, rate REAL DEFAULT 0, billed INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS appearances (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT, date TEXT, time TEXT, type TEXT, location TEXT, meetingLink TEXT, attorney TEXT, prepNote TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT, type TEXT, mimeType TEXT, date TEXT, size TEXT, content BLOB)`);
  await run(`CREATE TABLE IF NOT EXISTS case_notes (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, content TEXT NOT NULL, author TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT, number TEXT, date TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'Outstanding', dueDate TEXT, description TEXT, source TEXT DEFAULT 'time')`);
  await run(`CREATE TABLE IF NOT EXISTS invoice_items (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, timeEntryId TEXT, date TEXT, description TEXT, hours REAL DEFAULT 0, rate REAL DEFAULT 0, amount REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS integrations_log (id TEXT PRIMARY KEY, type TEXT NOT NULL, matterId TEXT, clientId TEXT, recipient TEXT, message TEXT, status TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS firm_settings (id TEXT PRIMARY KEY, name TEXT, logo TEXT, primaryColor TEXT, accentColor TEXT, websiteURL TEXT, email TEXT, phone TEXT, address TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS reminder_settings (id TEXT PRIMARY KEY, remindersEnabled INTEGER DEFAULT 1, whatsappEnabled INTEGER DEFAULT 0, emailEnabled INTEGER DEFAULT 0, twilioSid TEXT, twilioToken TEXT, twilioFromNumber TEXT, smtpHost TEXT, smtpPort TEXT, smtpUser TEXT, smtpPass TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS reminder_templates (id TEXT PRIMARY KEY, eventType TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS reminder_logs (id TEXT PRIMARY KEY, templateId TEXT, clientId TEXT, matterId TEXT, invoiceId TEXT, channel TEXT, recipient TEXT, status TEXT, sentAt TEXT, errorMessage TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS firm_notices (id TEXT PRIMARY KEY, title TEXT, content TEXT, createdAt TEXT, createdBy TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS payment_proofs (id TEXT PRIMARY KEY, invoiceId TEXT, matterId TEXT, clientId TEXT, method TEXT, reference TEXT, amount REAL DEFAULT 0, note TEXT, fileName TEXT, mimeType TEXT, size TEXT, content BLOB, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, email TEXT NOT NULL, clientId TEXT, token TEXT UNIQUE NOT NULL, status TEXT DEFAULT 'pending', createdBy TEXT, createdAt TEXT, expiresAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, userId TEXT, userName TEXT, role TEXT, action TEXT, entityType TEXT, entityId TEXT, summary TEXT, createdAt TEXT)`);

  await ensureClientUserSupport();
  await ensureColumn('appearances', 'meetingLink', 'TEXT');
  await ensureColumn('documents', 'source', "TEXT DEFAULT 'firm'");
  await ensureColumn('documents', 'folderId', 'TEXT');
  await ensureColumn('reminder_logs', 'invoiceId', 'TEXT');
  await seedReminderTemplates();

  const userCount = await get('SELECT COUNT(*) AS count FROM users');
  if (!userCount.count) {
    await run('INSERT INTO users (id,email,password,fullName,role,createdAt) VALUES (?,?,?,?,?,?)', [genId('U'), 'admin@lexflow.co.ke', await bcrypt.hash('admin123', 10), 'LexFlow Admin', 'admin', new Date().toISOString()]);
  }
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });
const requireAdvocateOrAdmin = (req, res, next) => ['advocate', 'admin'].includes(req.user?.role) ? next() : res.status(403).json({ error: 'Advocate or admin access required' });
const requireStaff = (req, res, next) => req.user?.role !== 'client' ? next() : res.status(403).json({ error: 'Staff access required' });
async function canAccessMatter(req, matterId) {
  if (req.user?.role !== 'client') return true;
  const matter = await get('SELECT id FROM matters WHERE id=? AND clientId=?', [matterId, req.user.clientId || '']);
  return Boolean(matter);
}
async function logAudit(req, action, entityType, entityId, summary) {
  if (!req.user) return;
  await run('INSERT INTO audit_logs (id,userId,userName,role,action,entityType,entityId,summary,createdAt) VALUES (?,?,?,?,?,?,?,?,?)', [
    genId('AUD'),
    req.user.userId || '',
    req.user.fullName || '',
    req.user.role || '',
    action,
    entityType,
    entityId || '',
    summary || '',
    new Date().toISOString(),
  ]);
}

async function clientUploadsFolder(matterId, userId = '') {
  let folder = await get('SELECT * FROM folders WHERE matterId=? AND lower(name)=lower(?)', [matterId, 'Client Uploads']);
  if (!folder) {
    const id = genId('FOL');
    await run('INSERT INTO folders (id,matterId,name,createdBy,createdAt) VALUES (?,?,?,?,?)', [id, matterId, 'Client Uploads', userId, new Date().toISOString()]);
    folder = await get('SELECT * FROM folders WHERE id=?', [id]);
  }
  return folder;
}

async function matterFolders(matterId) {
  const folders = await all(`SELECT f.*, (SELECT COUNT(*) FROM documents d WHERE d.folderId=f.id) documentCount FROM folders f WHERE f.matterId=? ORDER BY CASE WHEN lower(f.name)=lower('Client Uploads') THEN 0 ELSE 1 END, lower(f.name)`, [matterId]);
  const uncategorised = await get('SELECT COUNT(*) documentCount FROM documents WHERE matterId=? AND (folderId IS NULL OR folderId="")', [matterId]);
  return [{ id: 'all', matterId, name: 'All Documents', virtual: true }, { id: 'uncategorised', matterId, name: 'Uncategorised', virtual: true, documentCount: uncategorised.documentCount || 0 }, ...folders];
}

function appBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const host = req.get('host') || '';
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return 'http://localhost:5173';
  return `${req.protocol}://${host || 'localhost:5173'}`;
}

function invitationUrl(req, token) {
  return `${appBaseUrl(req)}/invite/${token}`;
}

function checkInvitationRateLimit(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const current = invitationAttempts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (current.resetAt < now) {
    current.count = 0;
    current.resetAt = now + windowMs;
  }
  current.count += 1;
  invitationAttempts.set(ip, current);
  if (current.count > 10) {
    res.status(429).json({ error: 'Too many invitation attempts. Please try again later.' });
    return false;
  }
  return true;
}

function renderTemplate(text = '', values = {}) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

async function logReminderAttempt({ templateId, clientId, matterId = '', invoiceId = '', channel, recipient, status, errorMessage = '' }) {
  await run('INSERT INTO reminder_logs (id,templateId,clientId,matterId,invoiceId,channel,recipient,status,sentAt,errorMessage) VALUES (?,?,?,?,?,?,?,?,?,?)', [genId('REMLOG'), templateId || '', clientId || '', matterId || '', invoiceId || '', channel || '', recipient || '', status, new Date().toISOString(), errorMessage || '']);
}

async function sendWhatsApp(settings, phone, message) {
  if (settings.twilioSid && settings.twilioToken && settings.twilioFromNumber) {
    const client = twilio(settings.twilioSid, settings.twilioToken);
    return client.messages.create({ from: settings.twilioFromNumber, to: phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`, body: message });
  }
  console.log(`[WhatsApp Stub] To: ${phone} - ${message}`);
  return { sid: `stub-${Date.now()}` };
}

async function sendEmail(settings, to, subject, body) {
  if (settings.smtpHost && settings.smtpUser && settings.smtpPass) {
    const transporter = nodemailer.createTransport({
      host: settings.smtpHost,
      port: Number(settings.smtpPort || 587),
      secure: Number(settings.smtpPort || 587) === 465,
      auth: { user: settings.smtpUser, pass: settings.smtpPass },
    });
    return transporter.sendMail({ from: settings.smtpUser, to, subject, text: body });
  }
  console.log(`[Email Stub] To: ${to} - Subject: ${subject} - ${body}`);
  return { messageId: `stub-${Date.now()}` };
}

async function sendReminderForChannel({ eventType, channel, client, matter, invoice, appearance, firm, settings }) {
  const template = await get('SELECT * FROM reminder_templates WHERE eventType=? AND channel=?', [eventType, channel]);
  if (!template) return;
  const values = {
    clientName: client?.name || 'Client',
    matterTitle: matter?.title || invoice?.matterTitle || 'your matter',
    courtDate: appearance?.date || '',
    courtTime: appearance?.time || 'TBA',
    invoiceAmount: money(invoice?.amount || 0),
    invoiceDueDate: invoice?.dueDate || '',
    firmName: firm.name || defaultFirmSettings.name,
    firmPhone: firm.phone || defaultFirmSettings.phone,
  };
  const recipient = channel === 'whatsapp' ? client?.phone : client?.email;
  if (!recipient) return logReminderAttempt({ templateId: template.id, clientId: client?.id, matterId: matter?.id, invoiceId: invoice?.id, channel, recipient: '', status: 'failed', errorMessage: `Missing ${channel === 'whatsapp' ? 'phone' : 'email'}` });
  try {
    if (channel === 'whatsapp') await sendWhatsApp(settings, recipient, renderTemplate(template.body, values));
    else await sendEmail(settings, recipient, renderTemplate(template.subject || 'Reminder from {{firmName}}', values), renderTemplate(template.body, values));
    await logReminderAttempt({ templateId: template.id, clientId: client?.id, matterId: matter?.id, invoiceId: invoice?.id, channel, recipient, status: 'sent' });
  } catch (err) {
    await logReminderAttempt({ templateId: template.id, clientId: client?.id, matterId: matter?.id, invoiceId: invoice?.id, channel, recipient, status: 'failed', errorMessage: err.message });
  }
}

async function sendReminder(eventType, context) {
  const firm = await getFirmSettings();
  const settings = firm.reminderSettings || defaultReminderSettings;
  if (!settings.remindersEnabled) return;
  if (settings.whatsappEnabled) await sendReminderForChannel({ ...context, eventType, channel: 'whatsapp', firm, settings });
  if (settings.emailEnabled) await sendReminderForChannel({ ...context, eventType, channel: 'email', firm, settings });
}

async function runCourtReminders(eventType, date) {
  const rows = await all(`SELECT a.*, m.title matterTitle, m.id matterId, m.clientId, c.name clientName, c.email clientEmail, c.phone clientPhone
    FROM appearances a
    LEFT JOIN matters m ON m.id=a.matterId
    LEFT JOIN clients c ON c.id=m.clientId
    WHERE a.date=?`, [date]);
  for (const row of rows) {
    await sendReminder(eventType, {
      appearance: row,
      matter: { id: row.matterId, title: row.matterTitle },
      client: { id: row.clientId, name: row.clientName, email: row.clientEmail, phone: row.clientPhone },
    });
  }
}

async function runInvoiceReminders(eventType, whereSql, params = []) {
  const rows = await all(`SELECT i.*, m.title matterTitle, m.id matterId, c.id clientId, c.name clientName, c.email clientEmail, c.phone clientPhone
    FROM invoices i
    LEFT JOIN matters m ON m.id=i.matterId
    LEFT JOIN clients c ON c.id=i.clientId
    WHERE ${whereSql}`, params);
  for (const row of rows) {
    await sendReminder(eventType, {
      invoice: { ...row, id: row.id, matterTitle: row.matterTitle },
      matter: { id: row.matterId, title: row.matterTitle },
      client: { id: row.clientId, name: row.clientName, email: row.clientEmail, phone: row.clientPhone },
    });
  }
}

function startReminderJobs() {
  if (reminderJobsStarted) return;
  reminderJobsStarted = true;
  cron.schedule('0 18 * * *', () => runCourtReminders('court_date_tomorrow', addDays(1)).catch(err => console.error('[LexFlow] Court reminder job failed', err)), { timezone: 'Africa/Nairobi' });
  cron.schedule('0 7 * * *', () => runCourtReminders('court_date_today', today()).catch(err => console.error('[LexFlow] Court reminder job failed', err)), { timezone: 'Africa/Nairobi' });
  cron.schedule('0 10 * * 1', () => runInvoiceReminders('invoice_overdue', "i.status='Overdue'").catch(err => console.error('[LexFlow] Invoice overdue job failed', err)), { timezone: 'Africa/Nairobi' });
  cron.schedule('0 10 * * 5', () => runInvoiceReminders('invoice_outstanding', "i.status='Outstanding' AND i.dueDate<=? AND i.dueDate>=?", [addDays(7), today()]).catch(err => console.error('[LexFlow] Invoice outstanding job failed', err)), { timezone: 'Africa/Nairobi' });
  if (process.env.REMINDER_CRON_TEST === '1') {
    cron.schedule('* * * * *', () => runCourtReminders('court_date_tomorrow', addDays(1)).catch(err => console.error('[LexFlow] Test reminder job failed', err)), { timezone: 'Africa/Nairobi' });
  }
  console.log('[LexFlow] Reminder jobs scheduled.');
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE lower(email)=lower(?)', [email || '']);
    if (!user || !(await bcrypt.compare(password || '', user.password || ''))) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.role === 'client') return res.status(403).json({ error: 'Please use the Client Portal login.' });
    const token = jwt.sign({ userId: user.id, role: user.role, fullName: user.fullName, clientId: user.clientId || '' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, name: user.fullName, role: user.role, clientId: user.clientId || '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/client-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE lower(email)=lower(?) AND role=?', [email || '', 'client']);
    if (!user || !(await bcrypt.compare(password || '', user.password || ''))) return res.status(401).json({ error: 'Invalid client email or password' });
    const token = jwt.sign({ userId: user.id, role: user.role, fullName: user.fullName, clientId: user.clientId || '' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, name: user.fullName, role: user.role, clientId: user.clientId || '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/firm-settings', async (req, res) => res.json(await getFirmSettings()));
app.get('/api/notices', async (req, res) => res.json(await all('SELECT * FROM firm_notices ORDER BY createdAt DESC')));
app.get('/api/invitations/:token', async (req, res) => {
  const invitation = await get('SELECT email,status,expiresAt FROM invitations WHERE token=?', [req.params.token]);
  if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
  if (invitation.status !== 'pending') return res.status(400).json({ error: `Invitation is ${invitation.status}` });
  if (new Date(invitation.expiresAt).getTime() < Date.now()) {
    await run("UPDATE invitations SET status='expired' WHERE token=?", [req.params.token]);
    return res.status(400).json({ error: 'Invitation has expired' });
  }
  res.json({ valid: true, email: invitation.email });
});
app.post('/api/invitations/:token/accept', async (req, res) => {
  if (!checkInvitationRateLimit(req, res)) return;
  const invitation = await get('SELECT * FROM invitations WHERE token=?', [req.params.token]);
  if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
  if (invitation.status !== 'pending') return res.status(400).json({ error: `Invitation is ${invitation.status}` });
  if (new Date(invitation.expiresAt).getTime() < Date.now()) {
    await run("UPDATE invitations SET status='expired' WHERE token=?", [req.params.token]);
    return res.status(400).json({ error: 'Invitation has expired' });
  }
  const { password, fullName } = req.body;
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = await get('SELECT id FROM users WHERE lower(email)=lower(?)', [invitation.email]);
  if (existing) return res.status(400).json({ error: 'A user with this email already exists' });
  const id = genId('U');
  const name = fullName || invitation.email.split('@')[0];
  const createdAt = new Date().toISOString();
  await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt) VALUES (?,?,?,?,?,?,?)', [id, invitation.email, await bcrypt.hash(password, 10), name, 'client', invitation.clientId || '', createdAt]);
  await run("UPDATE invitations SET status='used' WHERE token=?", [req.params.token]);
  const token = jwt.sign({ userId: id, role: 'client', fullName: name, clientId: invitation.clientId || '' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ message: 'Client portal account created.', token, user: { id, email: invitation.email, fullName: name, name, role: 'client', clientId: invitation.clientId || '' } });
});
app.put('/api/firm-settings', authenticate, requireAdmin, async (req, res) => {
  const settings = { ...defaultFirmSettings, ...req.body, id: 'default' };
  await run(`INSERT INTO firm_settings (id,name,logo,primaryColor,accentColor,websiteURL,email,phone,address)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, logo=excluded.logo, primaryColor=excluded.primaryColor, accentColor=excluded.accentColor, websiteURL=excluded.websiteURL, email=excluded.email, phone=excluded.phone, address=excluded.address`,
    [settings.id, settings.name, settings.logo, settings.primaryColor, settings.accentColor, settings.websiteURL, settings.email, settings.phone, settings.address]);
  if (req.body.reminderSettings) {
    await saveReminderSettings(req.body.reminderSettings);
    await logAudit(req, 'update', 'reminder_settings', 'default', 'Updated reminder channel settings');
  }
  await logAudit(req, 'update', 'firm_settings', 'default', `Updated firm settings for ${settings.name}`);
  res.json(await getFirmSettings());
});

app.use('/api', authenticate);

app.get('/api/auth/me', async (req, res) => {
  const user = await get('SELECT id,email,fullName,role,clientId,createdAt FROM users WHERE id=?', [req.user.userId]);
  user ? res.json({ ...user, name: user.fullName }) : res.status(404).json({ error: 'User not found' });
});
app.get('/api/auth/users', requireAdmin, async (req, res) => res.json(await all('SELECT id,email,fullName,role,clientId,createdAt FROM users ORDER BY createdAt DESC')));
app.post('/api/auth/register', requireAdmin, async (req, res) => {
  try {
    const { email, password, fullName, role = 'assistant', clientId = '' } = req.body;
    if (!email || !password || !fullName) return res.status(400).json({ error: 'email, password and fullName are required' });
    if (!['advocate', 'assistant', 'admin', 'client'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role === 'client' && !clientId) return res.status(400).json({ error: 'Client users must be linked to a client record' });
    const id = genId('U');
    const createdAt = new Date().toISOString();
    await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt) VALUES (?,?,?,?,?,?,?)', [id, email, await bcrypt.hash(password, 10), fullName, role, role === 'client' ? clientId : '', createdAt]);
    await logAudit(req, 'create', 'user', id, `Created ${role} user ${email}`);
    res.json({ id, email, fullName, name: fullName, role, clientId: role === 'client' ? clientId : '', createdAt });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/auth/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot delete your own account' });
  const user = await get('SELECT id,email,fullName,role FROM users WHERE id=?', [req.params.id]);
  await run('DELETE FROM users WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'user', req.params.id, `Deleted user ${user?.email || req.params.id}`);
  res.json({ id: req.params.id, deleted: true });
});

app.post('/api/invitations', requireAdmin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const clientId = req.body.clientId || '';
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (clientId) {
    const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
    if (!client) return res.status(400).json({ error: 'Linked client not found' });
  }
  const existingUser = await get('SELECT id FROM users WHERE lower(email)=lower(?)', [email]);
  if (existingUser) return res.status(400).json({ error: 'A user with this email already exists' });
  const id = genId('INVITE');
  const token = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  await run('INSERT INTO invitations (id,email,clientId,token,status,createdBy,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,?)', [id, email, clientId, token, 'pending', req.user.userId, createdAt, expiresAt]);
  const invite = await get(`SELECT i.*, c.name clientName FROM invitations i LEFT JOIN clients c ON c.id=i.clientId WHERE i.id=?`, [id]);
  const url = invitationUrl(req, token);
  console.log(`[LexFlow] Invitation link for ${email}: ${url}`);
  await logAudit(req, 'create', 'invitation', id, `Created client invitation for ${email}`);
  res.json({ ...invite, url });
});
app.get('/api/invitations', requireAdmin, async (req, res) => {
  const rows = await all(`SELECT i.*, c.name clientName FROM invitations i LEFT JOIN clients c ON c.id=i.clientId ORDER BY i.createdAt DESC`);
  res.json(rows.map(row => ({ ...row, url: invitationUrl(req, row.token) })));
});

app.get('/api/audit-logs', requireAdmin, async (req, res) => {
  const filters = [];
  const params = [];
  for (const field of ['userId', 'action', 'entityType', 'entityId']) {
    if (req.query[field]) {
      filters.push(`${field}=?`);
      params.push(req.query[field]);
    }
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await all(`SELECT * FROM audit_logs ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const countRow = await get(`SELECT COUNT(*) count FROM audit_logs ${where}`, params);
  res.json({ rows, total: countRow.count, limit, offset });
});

app.post('/api/notices', requireAdmin, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  const id = genId('NOTICE');
  await run('INSERT INTO firm_notices (id,title,content,createdAt,createdBy) VALUES (?,?,?,?,?)', [id, title, content, new Date().toISOString(), req.user.fullName || 'Admin']);
  await logAudit(req, 'create', 'notice', id, `Created firm notice ${title}`);
  res.json(await get('SELECT * FROM firm_notices WHERE id=?', [id]));
});
app.delete('/api/notices/:id', requireAdmin, async (req, res) => {
  const notice = await get('SELECT * FROM firm_notices WHERE id=?', [req.params.id]);
  await run('DELETE FROM firm_notices WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'notice', req.params.id, `Deleted firm notice ${notice?.title || req.params.id}`);
  res.json({ id: req.params.id, deleted: true });
});

app.get('/api/reminder-templates', requireAdmin, async (req, res) => {
  const rows = await all('SELECT * FROM reminder_templates ORDER BY eventType, channel');
  res.json(rows.map(row => {
    const defaults = defaultTemplateFor(row.eventType, row.channel) || {};
    return { ...row, defaultSubject: defaults.subject || '', defaultBody: defaults.body || '' };
  }));
});
app.put('/api/reminder-templates/:id', requireAdmin, async (req, res) => {
  const current = await get('SELECT * FROM reminder_templates WHERE id=?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Template not found' });
  const subject = req.body.subject ?? current.subject ?? '';
  const body = req.body.body ?? current.body;
  if (!body) return res.status(400).json({ error: 'Template body is required' });
  await run('UPDATE reminder_templates SET subject=?, body=? WHERE id=?', [subject, body, req.params.id]);
  await logAudit(req, 'update', 'reminder_template', req.params.id, `Updated ${current.eventType} ${current.channel} reminder template`);
  const updated = await get('SELECT * FROM reminder_templates WHERE id=?', [req.params.id]);
  const defaults = defaultTemplateFor(updated.eventType, updated.channel) || {};
  res.json({ ...updated, defaultSubject: defaults.subject || '', defaultBody: defaults.body || '' });
});
app.get('/api/reminder-logs', requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  res.json(await all('SELECT * FROM reminder_logs ORDER BY sentAt DESC LIMIT ?', [limit]));
});

app.get('/api/dashboard', requireStaff, async (req, res) => {
  const active = await get("SELECT COUNT(*) count FROM matters WHERE stage NOT IN ('Closed','On Hold')");
  const hours = await get("SELECT COALESCE(SUM(hours),0) hours, COALESCE(SUM(hours*rate),0) revenue FROM time_entries WHERE date LIKE ?", [`${today().slice(0, 7)}%`]);
  const overdue = await get('SELECT COUNT(*) count FROM tasks WHERE completed=0 AND dueDate < ?', [today()]);
  const upcomingEvents = await all('SELECT * FROM appearances WHERE date >= ? ORDER BY date LIMIT 5', [today()]);
  res.json({ activeMattersCount: active.count, monthHours: hours.hours, monthRevenue: hours.revenue, overdueTaskCount: overdue.count, upcomingEvents });
});

app.get('/api/clients', requireStaff, async (req, res) => res.json(await all('SELECT * FROM clients ORDER BY name')));
app.post('/api/clients', requireStaff, async (req, res) => {
  const id = genId('C');
  await run('INSERT INTO clients (id,name,type,contact,email,phone,status,joinDate,conflictCleared,retainer) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, req.body.name, req.body.type || 'Individual', req.body.contact || '', req.body.email || '', req.body.phone || '', 'Active', today(), 0, Number(req.body.retainer || 0)]);
  const client = await get('SELECT * FROM clients WHERE id=?', [id]);
  await logAudit(req, 'create', 'client', id, `Created client ${client.name}`);
  res.json(client);
});
app.patch('/api/clients/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['name', 'type', 'contact', 'email', 'phone', 'status', 'conflictCleared', 'retainer'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE clients SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => f === 'retainer' ? Number(req.body[f] || 0) : req.body[f]), req.params.id]);
  const client = await get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (client) await logAudit(req, 'update', 'client', req.params.id, `Updated client ${client.name}`);
  client ? res.json(client) : res.status(404).json({ error: 'Client not found' });
});
app.delete('/api/clients/:id', requireAdvocateOrAdmin, async (req, res) => {
  const client = await get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  const matters = await all('SELECT id FROM matters WHERE clientId=?', [req.params.id]);
  await run('BEGIN TRANSACTION');
  try {
    for (const matter of matters) await deleteMatterCascade(matter.id);
    await run('DELETE FROM clients WHERE id=?', [req.params.id]);
    await run('COMMIT');
    await logAudit(req, 'delete', 'client', req.params.id, `Deleted client ${client?.name || req.params.id} and ${matters.length} related matter(s)`);
    res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matters', async (req, res) => {
  const clientId = req.user.role === 'client' ? req.user.clientId : req.query.clientId;
  if (req.user.role === 'client' && !clientId) return res.json([]);
  if (clientId) return res.json(await all('SELECT m.*, c.name clientName, (SELECT MIN(date) FROM appearances a WHERE a.matterId=m.id AND a.date>=?) nextCourtDate FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.clientId=? ORDER BY openDate DESC', [today(), clientId]));
  res.json(await all('SELECT m.*, c.name clientName, (SELECT MIN(date) FROM appearances a WHERE a.matterId=m.id AND a.date>=?) nextCourtDate FROM matters m LEFT JOIN clients c ON c.id=m.clientId ORDER BY openDate DESC', [today()]));
});
app.get('/api/matters/:id', async (req, res) => {
  const matter = await get('SELECT m.*, c.name clientName, c.email clientEmail, c.phone clientPhone FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  if (req.user.role === 'client' && matter.clientId !== req.user.clientId) return res.status(403).json({ error: 'Matter access denied' });
  const [tasks, timeEntries, documents, notes, invoices, appearances] = await Promise.all([
    all('SELECT * FROM tasks WHERE matterId=? ORDER BY dueDate', [req.params.id]),
    all('SELECT * FROM time_entries WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT d.id,d.matterId,d.name,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,f.name folderName FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.matterId=? ORDER BY d.date DESC', [req.params.id]),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id]),
    all('SELECT * FROM invoices WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT * FROM appearances WHERE matterId=? ORDER BY date', [req.params.id])
  ]);
  res.json({ ...matter, tasks, timeEntries, documents, notes, invoices, appearances });
});
app.get('/api/matters/:id/suggestions', async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Staff access required' });
  const matter = await get('SELECT m.*, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });

  const todayDate = today();
  const [taskStats, timeStats, docStats, noteStats, invoiceStats, nextAppearance] = await Promise.all([
    get('SELECT COUNT(*) total, SUM(CASE WHEN completed=0 AND dueDate < ? THEN 1 ELSE 0 END) overdue FROM tasks WHERE matterId=?', [todayDate, req.params.id]),
    get('SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN billed=0 THEN hours*rate ELSE 0 END),0) unbilled FROM time_entries WHERE matterId=?', [req.params.id]),
    get('SELECT COUNT(*) total FROM documents WHERE matterId=?', [req.params.id]),
    get('SELECT COUNT(*) total FROM case_notes WHERE matterId=?', [req.params.id]),
    get(`SELECT COUNT(*) total, SUM(CASE WHEN status='Outstanding' THEN 1 ELSE 0 END) outstanding FROM invoices WHERE matterId=?`, [req.params.id]),
    get('SELECT * FROM appearances WHERE matterId=? AND date>=? ORDER BY date LIMIT 1', [req.params.id, todayDate]),
  ]);

  const suggestions = [];
  const taskTotal = Number(taskStats?.total || 0);
  const overdueTasks = Number(taskStats?.overdue || 0);
  const timeTotal = Number(timeStats?.total || 0);
  const unbilled = Number(timeStats?.unbilled || 0);
  const docTotal = Number(docStats?.total || 0);
  const noteTotal = Number(noteStats?.total || 0);
  const invoiceTotal = Number(invoiceStats?.total || 0);
  const outstandingInvoices = Number(invoiceStats?.outstanding || 0);

  if ((matter.stage || '').toLowerCase() === 'intake' && taskTotal === 0 && timeTotal === 0 && noteTotal === 0) {
    suggestions.push('This matter is still in Intake with no activity. Consider moving it to Conflict Check or creating the first task.');
  }
  if (overdueTasks > 0) suggestions.push(`${overdueTasks} overdue task${overdueTasks === 1 ? '' : 's'} need follow-up before the file slips.`);
  if (nextAppearance) {
    const daysAway = Math.ceil((new Date(`${nextAppearance.date}T00:00:00`) - new Date(`${todayDate}T00:00:00`)) / 86400000);
    if (daysAway <= 3) suggestions.push(`${nextAppearance.type || 'Court'} date is ${daysAway === 0 ? 'today' : `in ${daysAway} day${daysAway === 1 ? '' : 's'}`}. Review preparation notes and confirm attendance logistics.`);
    if (!nextAppearance.prepNote) suggestions.push('The next court appearance has no preparation note. Add a short prep note so the team knows what to review.');
  }
  if (docTotal === 0) suggestions.push('No documents are linked to this matter yet. Upload key pleadings, engagement letters, or court notices for quick reference.');
  if (unbilled > 0) suggestions.push(`There is ${unbilled.toLocaleString('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 })} in unbilled time. Consider generating an invoice.`);
  if ((matter.billingType || '').toLowerCase() === 'fixed' && Number(matter.fixedFee || 0) > 0 && invoiceTotal === 0) suggestions.push('This is a fixed-fee matter with no invoice yet. Generate the fixed-fee invoice when engagement is confirmed.');
  if (Number(matter.retainerBalance || 0) > 0 && Number(matter.retainerBalance || 0) < 50000) suggestions.push('Retainer balance is running low. Consider requesting a top-up before more billable work is done.');
  if ((matter.stage || '').toLowerCase() === 'closed' && outstandingInvoices > 0) suggestions.push('This matter is closed but still has an outstanding invoice. Follow up with the client or mark payment when received.');
  if (noteTotal === 0 && taskTotal > 0) suggestions.push('There are tasks on this file but no case notes. Add a short status note to preserve matter context.');
  if (!suggestions.length) suggestions.push('This matter looks up to date. No urgent action is needed right now.');

  res.json(suggestions);
});
app.post('/api/matters', requireAdvocateOrAdmin, async (req, res) => {
  const id = genId('M');
  const reference = req.body.reference || `LEX-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
  await run(`INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,paralegal,openDate,description,court,judge,caseNo,opposingCounsel,billingRate,retainerBalance,totalBilled,priority,solDate,billingType,fixedFee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, reference, req.body.clientId, req.body.title, req.body.practiceArea || '', req.body.stage || 'Intake', req.body.assignedTo || '', req.body.paralegal || '', req.body.openDate || today(), req.body.description || '', req.body.court || '', req.body.judge || '', req.body.caseNo || '', req.body.opposingCounsel || '', Number(req.body.billingRate || 0), Number(req.body.retainerBalance || 0), 0, req.body.priority || 'Medium', req.body.solDate || '', req.body.billingType || 'hourly', Number(req.body.fixedFee || 0)]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [id]);
  await logAudit(req, 'create', 'matter', id, `Created matter ${matter.title} (${matter.reference})`);
  res.json(matter);
});
app.patch('/api/matters/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['reference','clientId','title','practiceArea','stage','assignedTo','paralegal','openDate','description','court','judge','caseNo','opposingCounsel','priority','billingRate','billingType','fixedFee','retainerBalance','totalBilled','solDate'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE matters SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => ['billingRate','fixedFee','retainerBalance','totalBilled'].includes(f) ? Number(req.body[f] || 0) : req.body[f]), req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
  if (matter) await logAudit(req, 'update', 'matter', req.params.id, `Updated matter ${matter.title}`);
  matter ? res.json(matter) : res.status(404).json({ error: 'Matter not found' });
});
app.patch('/api/matters/:id/status', requireAdvocateOrAdmin, async (req, res) => {
  await run('UPDATE matters SET stage=? WHERE id=?', [req.body.stage || 'Closed', req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
  if (matter) await logAudit(req, 'archive', 'matter', req.params.id, `Set matter ${matter.title} stage to ${matter.stage}`);
  matter ? res.json(matter) : res.status(404).json({ error: 'Matter not found' });
});
async function deleteMatterCascade(matterId) {
  const invoices = await all('SELECT id FROM invoices WHERE matterId=?', [matterId]);
  for (const invoice of invoices) await run('DELETE FROM invoice_items WHERE invoiceId=?', [invoice.id]);
  await run('DELETE FROM invoices WHERE matterId=?', [matterId]);
  await run('DELETE FROM tasks WHERE matterId=?', [matterId]);
  await run('DELETE FROM time_entries WHERE matterId=?', [matterId]);
  await run('DELETE FROM appearances WHERE matterId=?', [matterId]);
  await run('DELETE FROM documents WHERE matterId=?', [matterId]);
  await run('DELETE FROM folders WHERE matterId=?', [matterId]);
  await run('DELETE FROM case_notes WHERE matterId=?', [matterId]);
  await run('DELETE FROM integrations_log WHERE matterId=?', [matterId]);
  await run('DELETE FROM payment_proofs WHERE matterId=?', [matterId]);
  await run('DELETE FROM matters WHERE id=?', [matterId]);
}
app.delete('/api/matters/:id', requireAdvocateOrAdmin, async (req, res) => {
  const matter = await get('SELECT id,title,reference FROM matters WHERE id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  await run('BEGIN TRANSACTION');
  try {
    await deleteMatterCascade(req.params.id);
    await run('COMMIT');
    await logAudit(req, 'delete', 'matter', req.params.id, `Deleted matter ${matter.title} (${matter.reference || matter.id})`);
    res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks', requireStaff, async (req, res) => res.json(await all('SELECT * FROM tasks ORDER BY dueDate')));
app.post('/api/tasks', requireStaff, async (req, res) => { const id = genId('T'); await run('INSERT INTO tasks (id,matterId,title,completed,assignee,dueDate,auto_generated) VALUES (?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.title, req.body.completed ? 1 : 0, req.body.assignee || '', req.body.dueDate || '', 0]); const task = await get('SELECT * FROM tasks WHERE id=?', [id]); await logAudit(req, 'create', 'task', id, `Created task ${task.title}`); res.json(task); });
app.patch('/api/tasks/:id', requireAdvocateOrAdmin, async (req, res) => { await run('UPDATE tasks SET completed=COALESCE(?,completed), title=COALESCE(?,title), assignee=COALESCE(?,assignee), dueDate=COALESCE(?,dueDate) WHERE id=?', [req.body.completed === undefined ? null : (req.body.completed ? 1 : 0), req.body.title ?? null, req.body.assignee ?? null, req.body.dueDate ?? null, req.params.id]); const task = await get('SELECT * FROM tasks WHERE id=?', [req.params.id]); if (task) await logAudit(req, req.body.completed !== undefined ? 'complete' : 'update', 'task', req.params.id, `${req.body.completed !== undefined ? (task.completed ? 'Completed' : 'Reopened') : 'Updated'} task ${task.title}`); res.json(task); });
app.delete('/api/tasks/:id', requireAdvocateOrAdmin, async (req, res) => { const task = await get('SELECT * FROM tasks WHERE id=?', [req.params.id]); await run('DELETE FROM tasks WHERE id=?', [req.params.id]); await logAudit(req, 'delete', 'task', req.params.id, `Deleted task ${task?.title || req.params.id}`); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/time-entries', requireStaff, async (req, res) => res.json(await all('SELECT * FROM time_entries ORDER BY date DESC')));
app.post('/api/time-entries', requireStaff, async (req, res) => { const id = genId('TIME'); await run('INSERT INTO time_entries (id,matterId,attorney,date,hours,activity,description,rate,billed) VALUES (?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.attorney || req.user.fullName || '', req.body.date || today(), Number(req.body.hours || 0), req.body.activity || '', req.body.description || '', Number(req.body.rate || 0), req.body.billed ? 1 : 0]); const entry = await get('SELECT * FROM time_entries WHERE id=?', [id]); await logAudit(req, 'create', 'time_entry', id, `Logged ${entry.hours} hour(s) for matter ${entry.matterId}`); res.json(entry); });
app.patch('/api/time-entries/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['matterId','attorney','date','hours','activity','description','rate','billed'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE time_entries SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => ['hours','rate'].includes(f) ? Number(req.body[f] || 0) : f === 'billed' ? (req.body[f] ? 1 : 0) : req.body[f]), req.params.id]);
  const entry = await get('SELECT * FROM time_entries WHERE id=?', [req.params.id]);
  if (entry) await logAudit(req, req.body.billed !== undefined ? 'bill_toggle' : 'update', 'time_entry', req.params.id, `${req.body.billed !== undefined ? (entry.billed ? 'Marked billed' : 'Marked unbilled') : 'Updated'} time entry for matter ${entry.matterId}`);
  entry ? res.json(entry) : res.status(404).json({ error: 'Time entry not found' });
});
app.delete('/api/time-entries/:id', requireAdvocateOrAdmin, async (req, res) => { const entry = await get('SELECT * FROM time_entries WHERE id=?', [req.params.id]); await run('DELETE FROM time_entries WHERE id=?', [req.params.id]); await logAudit(req, 'delete', 'time_entry', req.params.id, `Deleted time entry for matter ${entry?.matterId || ''}`); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/appearances', requireStaff, async (req, res) => res.json(await all('SELECT * FROM appearances ORDER BY date')));
app.get('/api/appearances/upcoming', requireStaff, async (req, res) => res.json(await all('SELECT * FROM appearances WHERE date>=? ORDER BY date LIMIT 20', [today()])));
app.post('/api/appearances', requireAdvocateOrAdmin, async (req, res) => { const id = genId('EV'); await run('INSERT INTO appearances (id,matterId,title,date,time,type,location,meetingLink,attorney,prepNote) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.title, req.body.date, req.body.time || '9:00 AM', req.body.type || 'Hearing', req.body.location || '', req.body.meetingLink || '', req.body.attorney || '', req.body.prepNote || '']); const event = await get('SELECT * FROM appearances WHERE id=?', [id]); await logAudit(req, 'create', 'appearance', id, `Scheduled ${event.type || 'appearance'} ${event.title || ''} on ${event.date}`); res.json(event); });
app.patch('/api/appearances/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['matterId','title','date','time','type','location','meetingLink','attorney','prepNote'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE appearances SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => req.body[f]), req.params.id]);
  const event = await get('SELECT * FROM appearances WHERE id=?', [req.params.id]);
  if (event) await logAudit(req, 'update', 'appearance', req.params.id, `Updated appearance ${event.title || event.type || req.params.id}`);
  event ? res.json(event) : res.status(404).json({ error: 'Appearance not found' });
});
app.delete('/api/appearances/:id', requireAdvocateOrAdmin, async (req, res) => { const event = await get('SELECT * FROM appearances WHERE id=?', [req.params.id]); await run('DELETE FROM appearances WHERE id=?', [req.params.id]); await logAudit(req, 'delete', 'appearance', req.params.id, `Deleted appearance ${event?.title || event?.type || req.params.id}`); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/matters/:id/folders', async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' });
  res.json(await matterFolders(req.params.id));
});
app.post('/api/matters/:id/folders', requireAdvocateOrAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const matter = await get('SELECT id FROM matters WHERE id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  const existing = await get('SELECT id FROM folders WHERE matterId=? AND lower(name)=lower(?)', [req.params.id, name]);
  if (existing) return res.status(400).json({ error: 'Folder already exists for this matter' });
  const id = genId('FOL');
  await run('INSERT INTO folders (id,matterId,name,createdBy,createdAt) VALUES (?,?,?,?,?)', [id, req.params.id, name, req.user.userId || '', new Date().toISOString()]);
  await logAudit(req, 'create', 'folder', id, `Created folder ${name}`);
  res.json(await get('SELECT * FROM folders WHERE id=?', [id]));
});
app.patch('/api/folders/:id', requireAdvocateOrAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const folder = await get('SELECT * FROM folders WHERE id=?', [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const existing = await get('SELECT id FROM folders WHERE matterId=? AND lower(name)=lower(?) AND id<>?', [folder.matterId, name, req.params.id]);
  if (existing) return res.status(400).json({ error: 'Folder already exists for this matter' });
  await run('UPDATE folders SET name=? WHERE id=?', [name, req.params.id]);
  await logAudit(req, 'update', 'folder', req.params.id, `Renamed folder ${folder.name} to ${name}`);
  res.json(await get('SELECT * FROM folders WHERE id=?', [req.params.id]));
});
app.delete('/api/folders/:id', requireAdvocateOrAdmin, async (req, res) => {
  const folder = await get('SELECT * FROM folders WHERE id=?', [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const count = await get('SELECT COUNT(*) count FROM documents WHERE folderId=?', [req.params.id]);
  if (count.count) return res.status(400).json({ error: 'Folder must be empty before it can be deleted' });
  await run('DELETE FROM folders WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'folder', req.params.id, `Deleted folder ${folder.name}`);
  res.json({ id: req.params.id, deleted: true });
});
app.get('/api/matters/:id/documents', async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' });
  const folderId = req.query.folderId || '';
  const params = [req.params.id];
  let where = 'd.matterId=?';
  if (folderId && folderId !== 'all') {
    if (folderId === 'uncategorised') where += ' AND (d.folderId IS NULL OR d.folderId="")';
    else { where += ' AND d.folderId=?'; params.push(folderId); }
  }
  res.json(await all(`SELECT d.id,d.matterId,d.name,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,f.name folderName FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE ${where} ORDER BY d.date DESC, d.name`, params));
});
app.post('/api/matters/:id/documents', async (req, res) => {
  if (req.user.role === 'client') {
    if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' });
  } else if (!['advocate', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Advocate or admin access required' });
  }
  const { name, mimeType, data } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name and data are required' });
  const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const imageAllowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (![...allowed, ...imageAllowed].includes(mimeType)) return res.status(400).json({ error: 'Only PDF, Word and image documents are supported' });
  const id = genId('DOC');
  const buffer = Buffer.from(String(data).split(',').pop(), 'base64');
  const source = req.user.role === 'client' ? 'client' : 'firm';
  let folderId = '';
  if (req.user.role === 'client') {
    const folder = await clientUploadsFolder(req.params.id, req.user.userId || '');
    folderId = folder.id;
  } else if (req.body.folderId && req.body.folderId !== 'uncategorised' && req.body.folderId !== 'all') {
    const folder = await get('SELECT id FROM folders WHERE id=? AND matterId=?', [req.body.folderId, req.params.id]);
    if (!folder) return res.status(400).json({ error: 'Folder not found for this matter' });
    folderId = folder.id;
  }
  const type = imageAllowed.includes(mimeType) ? 'Image' : mimeType.includes('pdf') ? 'PDF' : 'Word';
  await run('INSERT INTO documents (id,matterId,name,type,mimeType,date,size,content,source,folderId) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, req.params.id, name.replace(/[^\w .-]/g, '_'), type, mimeType, today(), `${Math.max(1, Math.round(buffer.length / 1024))} KB`, buffer, source, folderId || null]);
  const doc = await get('SELECT d.id,d.matterId,d.name,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,f.name folderName FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?', [id]);
  await logAudit(req, 'upload', 'document', id, `Uploaded document ${doc.name}`);
  res.json(doc);
});
app.get('/api/documents/:id/download', async (req, res) => { const doc = await get('SELECT * FROM documents WHERE id=?', [req.params.id]); if (!doc) return res.status(404).json({ error: 'Document not found' }); if (!(await canAccessMatter(req, doc.matterId))) return res.status(403).json({ error: 'Document access denied' }); res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="${doc.name}"`); res.send(doc.content); });
app.patch('/api/documents/:id', requireAdvocateOrAdmin, async (req, res) => {
  const doc = await get('SELECT * FROM documents WHERE id=?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  let folderId = req.body.folderId || '';
  if (folderId && folderId !== 'uncategorised' && folderId !== 'all') {
    const folder = await get('SELECT id FROM folders WHERE id=? AND matterId=?', [folderId, doc.matterId]);
    if (!folder) return res.status(400).json({ error: 'Folder not found for this matter' });
  } else folderId = null;
  await run('UPDATE documents SET folderId=? WHERE id=?', [folderId, req.params.id]);
  await logAudit(req, 'update', 'document', req.params.id, `Moved document ${doc.name}`);
  res.json(await get('SELECT d.id,d.matterId,d.name,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,f.name folderName FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?', [req.params.id]));
});
app.delete('/api/documents/:id', requireAdvocateOrAdmin, async (req, res) => { const doc = await get('SELECT id,name,matterId FROM documents WHERE id=?', [req.params.id]); await run('DELETE FROM documents WHERE id=?', [req.params.id]); await logAudit(req, 'delete', 'document', req.params.id, `Deleted document ${doc?.name || req.params.id}`); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/matters/:id/notes', async (req, res) => { if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' }); if (req.user.role === 'client') return res.json([]); res.json(await all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id])); });
app.post('/api/matters/:id/notes', async (req, res) => { if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' }); const id = genId('NOTE'); await run('INSERT INTO case_notes (id,matterId,content,author,createdAt) VALUES (?,?,?,?,?)', [id, req.params.id, req.body.content, req.user.role === 'client' ? req.user.fullName : (req.body.author || req.user.fullName || 'Unknown'), new Date().toISOString()]); res.json(await get('SELECT * FROM case_notes WHERE id=?', [id])); });

app.get('/api/invoices', async (req, res) => {
  if (req.user.role === 'client') return res.json(await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE i.clientId=? ORDER BY i.date DESC, i.number DESC`, [req.user.clientId || '']));
  res.json(await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId ORDER BY i.date DESC, i.number DESC`));
});
app.post('/api/invoices/generate', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const matter = await get('SELECT * FROM matters WHERE id=?', [req.body.matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    const date = today();
    const dueDate = req.body.dueDate || addDays(30);
    const id = genId('INV');
    const number = invoiceNumber();
    let amount = 0;
    let source = 'hourly';
    let items = [];
    if (matter.billingType === 'fixed') {
      amount = Number(matter.fixedFee || 0);
      source = 'fixed';
      items = [{ description: 'Legal Services (Fixed Fee)', hours: 0, rate: 0, amount }];
    } else {
      const entries = await all('SELECT * FROM time_entries WHERE matterId=? AND billed=0', [matter.id]);
      items = entries.map(t => ({ timeEntryId: t.id, date: t.date, description: t.description || t.activity || 'Legal Services', hours: Number(t.hours || 0), rate: Number(t.rate || 0), amount: Number(t.hours || 0) * Number(t.rate || 0) }));
      amount = items.reduce((sum, item) => sum + item.amount, 0);
    }
    if (amount <= 0) return res.status(400).json({ error: 'No billable amount found for this matter' });
    await run('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, matter.id, matter.clientId, number, date, amount, 'Outstanding', dueDate, source === 'fixed' ? 'Fixed fee invoice' : 'Unbilled time invoice', source]);
    for (const item of items) await run('INSERT INTO invoice_items (id,invoiceId,timeEntryId,date,description,hours,rate,amount) VALUES (?,?,?,?,?,?,?,?)', [genId('ITEM'), id, item.timeEntryId || '', item.date || date, item.description, item.hours, item.rate, item.amount]);
    if (source === 'hourly' && items.length) await run(`UPDATE time_entries SET billed=1 WHERE id IN (${items.map(() => '?').join(',')})`, items.map(i => i.timeEntryId));
    await run('UPDATE matters SET totalBilled=COALESCE(totalBilled,0)+? WHERE id=?', [amount, matter.id]);
    await logAudit(req, 'generate', 'invoice', id, `Generated invoice ${number} for matter ${matter.title}`);
    res.json(await invoiceWithDetails(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
async function invoiceWithDetails(id) {
  const invoice = await get(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName, c.email clientEmail, c.phone clientPhone, c.contact clientAddress FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE i.id=?`, [id]);
  if (!invoice) return null;
  invoice.items = await all('SELECT * FROM invoice_items WHERE invoiceId=? ORDER BY date', [id]);
  return invoice;
}
app.get('/api/invoices/:id', async (req, res) => { const invoice = await invoiceWithDetails(req.params.id); if (!invoice) return res.status(404).json({ error: 'Invoice not found' }); if (req.user.role === 'client' && invoice.clientId !== req.user.clientId) return res.status(403).json({ error: 'Invoice access denied' }); res.json(invoice); });
app.patch('/api/invoices/:id/status', requireAdmin, async (req, res) => { if (!['Paid', 'Outstanding', 'Overdue'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid invoice status' }); await run('UPDATE invoices SET status=? WHERE id=?', [req.body.status, req.params.id]); const invoice = await invoiceWithDetails(req.params.id); await logAudit(req, 'status', 'invoice', req.params.id, `Set invoice ${invoice?.number || req.params.id} status to ${req.body.status}`); res.json(invoice); });
app.delete('/api/invoices/:id', requireAdvocateOrAdmin, async (req, res) => {
  const invoice = await get('SELECT * FROM invoices WHERE id=?', [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'Paid') return res.status(400).json({ error: 'Paid invoices cannot be deleted' });
  await run('DELETE FROM invoice_items WHERE invoiceId=?', [req.params.id]);
  await run('DELETE FROM invoices WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'invoice', req.params.id, `Deleted invoice ${invoice.number || req.params.id}`);
  res.json({ id: req.params.id, deleted: true });
});
app.get('/api/invoices/:id/pdf', async (req, res) => {
  const invoice = await invoiceWithDetails(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (req.user.role === 'client' && invoice.clientId !== req.user.clientId) return res.status(403).json({ error: 'Invoice access denied' });
  const firm = await getFirmSettings();
  const subtotal = Number(invoice.amount || 0);
  const vat = subtotal * 0.16;
  const total = subtotal + vat;
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.number || invoice.id}.pdf"`);
  doc.pipe(res);
  doc.rect(48, 42, 52, 52).fill(firm.primaryColor || '#1B3A5C');
  if (firm.logo && String(firm.logo).startsWith('data:image')) {
    try { doc.image(Buffer.from(String(firm.logo).split(',').pop(), 'base64'), 52, 46, { fit: [44, 44] }); } catch { doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('LF', 64, 60); }
  } else {
    doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('LF', 64, 60);
  }
  doc.fillColor('#111827').fontSize(22).text(firm.name || 'LexFlow Kenya', 112, 46);
  doc.fontSize(10).fillColor('#6B7280').font('Helvetica').text(firm.address || 'Kenyan Law Practice Management', 112, 74);
  doc.fillColor('#1B3A5C').fontSize(24).font('Helvetica-Bold').text('INVOICE', 400, 48, { align: 'right' });
  doc.moveTo(48, 112).lineTo(547, 112).strokeColor('#E5E7EB').stroke();
  doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text('Bill To', 48, 132);
  doc.font('Helvetica').fillColor('#374151').text(invoice.clientName || 'Client', 48, 150).text(invoice.clientAddress || invoice.clientEmail || invoice.clientPhone || 'Address on file', 48, 166, { width: 230 });
  [['Invoice #', invoice.number], ['Date', invoice.date], ['Due Date', invoice.dueDate], ['Status', invoice.status]].forEach(([label, value], i) => { const y = 132 + i * 18; doc.font('Helvetica-Bold').fillColor('#6B7280').text(label, 350, y); doc.font('Helvetica').fillColor('#111827').text(String(value || ''), 440, y, { width: 105, align: 'right' }); });
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(11).text('Matter', 48, 220); doc.font('Helvetica').fontSize(10).text(`${invoice.reference || ''} ${invoice.matterTitle || ''}`.trim(), 48, 238, { width: 460 });
  const top = 282; doc.rect(48, top, 499, 24).fill('#F3F4F6'); doc.fillColor('#374151').font('Helvetica-Bold').fontSize(9); doc.text('Date', 56, top + 8); doc.text('Description', 132, top + 8); doc.text('Hours', 330, top + 8, { width: 42, align: 'right' }); doc.text('Rate', 382, top + 8, { width: 70, align: 'right' }); doc.text('Amount', 465, top + 8, { width: 70, align: 'right' });
  let y = top + 36; doc.font('Helvetica').fontSize(9).fillColor('#111827'); for (const item of invoice.items || []) { if (y > 690) { doc.addPage(); y = 60; } doc.text(item.date || invoice.date, 56, y); doc.text(item.description || 'Legal Services', 132, y, { width: 185 }); doc.text(Number(item.hours || 0).toFixed(item.hours ? 2 : 0), 330, y, { width: 42, align: 'right' }); doc.text(money(item.rate), 382, y, { width: 70, align: 'right' }); doc.text(money(item.amount), 465, y, { width: 70, align: 'right' }); y += 24; }
  y = Math.max(y + 24, 610); [['Subtotal', subtotal], ['VAT (16%)', vat], ['Total', total]].forEach(([label, value], i) => { doc.font(i === 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 2 ? 12 : 10).fillColor(i === 2 ? '#1B3A5C' : '#374151'); doc.text(label, 350, y + i * 22); doc.text(money(value), 440, y + i * 22, { width: 105, align: 'right' }); });
  doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text(`${firm.name || 'LexFlow Kenya'} | ${firm.address || 'Nairobi, Kenya'} | ${firm.email || 'accounts@lexflow.co.ke'} | ${firm.phone || '+254 700 123456'}`, 48, 760, { align: 'center', width: 499 });
  doc.end();
});

app.get('/api/client/dashboard', async (req, res) => {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Client access required' });
  const client = await get('SELECT * FROM clients WHERE id=?', [req.user.clientId || '']);
  const matters = await all('SELECT m.*, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.clientId=? ORDER BY m.openDate DESC', [req.user.clientId || '']);
  const matterIds = matters.map(m => m.id);
  const placeholders = matterIds.map(() => '?').join(',');
  const documents = matterIds.length ? await all(`SELECT d.id,d.matterId,d.name,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,f.name folderName FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.matterId IN (${placeholders}) ORDER BY d.date DESC`, matterIds) : [];
  const invoices = await all(`SELECT i.*, m.title matterTitle, m.reference FROM invoices i LEFT JOIN matters m ON m.id=i.matterId WHERE i.clientId=? ORDER BY i.date DESC`, [req.user.clientId || '']);
  const appearances = matterIds.length ? await all(`SELECT * FROM appearances WHERE matterId IN (${placeholders}) ORDER BY date`, matterIds) : [];
  const notices = await all('SELECT * FROM firm_notices ORDER BY createdAt DESC LIMIT 20');
  const paymentProofs = await all('SELECT id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,createdAt FROM payment_proofs WHERE clientId=? ORDER BY createdAt DESC', [req.user.clientId || '']);
  res.json({ client, matters, documents, invoices, notes: [], appearances, notices, paymentProofs });
});

app.post('/api/payment-proofs', async (req, res) => {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Client access required' });
  const { invoiceId, matterId, method = 'M-PESA', reference, amount, note = '', fileName, mimeType, data } = req.body;
  if (!matterId || !reference) return res.status(400).json({ error: 'matterId and reference are required' });
  if (!(await canAccessMatter(req, matterId))) return res.status(403).json({ error: 'Matter access denied' });
  if (invoiceId) {
    const invoice = await get('SELECT id,clientId,matterId FROM invoices WHERE id=?', [invoiceId]);
    if (!invoice || invoice.clientId !== req.user.clientId || invoice.matterId !== matterId) return res.status(403).json({ error: 'Invoice access denied' });
  }
  const id = genId('PAY');
  const buffer = data ? Buffer.from(String(data).split(',').pop(), 'base64') : null;
  await run('INSERT INTO payment_proofs (id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,content,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    id,
    invoiceId || '',
    matterId,
    req.user.clientId || '',
    method,
    reference,
    Number(amount || 0),
    note,
    fileName ? fileName.replace(/[^\w .-]/g, '_') : '',
    mimeType || '',
    buffer ? `${Math.max(1, Math.round(buffer.length / 1024))} KB` : '',
    buffer,
    new Date().toISOString(),
  ]);
  await logAudit(req, 'upload', 'payment_proof', id, `Uploaded payment proof ${reference} for matter ${matterId}`);
  res.json(await get('SELECT id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,createdAt FROM payment_proofs WHERE id=?', [id]));
});

app.get('/api/search', requireStaff, async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  if (q === '%%') return res.json([]);
  const matters = await all(`SELECT m.id,m.title,m.reference,c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.title LIKE ? OR m.reference LIKE ? OR c.name LIKE ? LIMIT 15`, [q, q, q]);
  const clients = await all('SELECT id,name,email,phone FROM clients WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 15', [q, q, q]);
  res.json([...matters.map(m => ({ type: 'Matter', id: m.id, matterId: m.id, title: m.title, subtitle: `${m.reference || ''} ${m.clientName || ''}`.trim() })), ...clients.map(c => ({ type: 'Client', id: c.id, title: c.name, subtitle: `${c.email || ''} ${c.phone || ''}`.trim() }))]);
});

app.post('/api/mpesa/stk-push', requireStaff, async (req, res) => { const id = genId('MPESA'); await run('INSERT INTO integrations_log (id,type,matterId,clientId,recipient,message,status,createdAt) VALUES (?,?,?,?,?,?,?,?)', [id, 'mpesa', req.body.matterId || '', req.body.clientId || '', req.body.phone || '', `STK push amount ${req.body.amount}`, 'Queued', new Date().toISOString()]); res.json({ id, status: 'Queued', checkoutRequestId: `ws_CO_${Date.now()}`, message: 'STK push queued. Add Daraja credentials for live payments.' }); });
app.post('/api/whatsapp/reminders', requireStaff, async (req, res) => { const rows = await all(`SELECT a.*,m.clientId,m.title matterTitle,c.name clientName,c.phone FROM appearances a LEFT JOIN matters m ON m.id=a.matterId LEFT JOIN clients c ON c.id=m.clientId WHERE a.date BETWEEN ? AND ?`, [today(), addDays(Number(req.body.days || 3))]); const reminders = rows.map(r => ({ id: genId('WA'), matterId: r.matterId, clientName: r.clientName, phone: r.phone, message: `Reminder: ${r.title} for ${r.matterTitle} is on ${r.date} at ${r.time || 'TBA'}.`, status: r.phone ? 'Queued' : 'Missing phone' })); res.json({ count: reminders.length, reminders }); });
app.get('/api/exports/:type.:format', requireStaff, async (req, res) => { const rows = req.params.type === 'itax' ? await all(`SELECT i.number,i.date,c.name client,i.amount,i.status FROM invoices i LEFT JOIN clients c ON c.id=i.clientId`) : await all(`SELECT m.reference,m.title,c.name client,m.practiceArea,m.stage,m.totalBilled FROM matters m LEFT JOIN clients c ON c.id=m.clientId`); if (req.params.format === 'pdf') { const doc = new PDFDocument(); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-report.pdf"`); doc.pipe(res); doc.fontSize(18).text(`${req.params.type.toUpperCase()} Report`); rows.forEach(r => doc.fontSize(10).text(Object.values(r).join(' | '))); doc.end(); } else { res.setHeader('Content-Type', 'application/vnd.ms-excel'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-report.xls"`); res.send(rows.map(r => Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')); } });

initDb().then(() => {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`LexFlow Kenya server running at http://localhost:${PORT}`);
    startReminderJobs();
  });
}).catch(err => {
  console.error('Database initialisation failed', err);
  process.exit(1);
});
