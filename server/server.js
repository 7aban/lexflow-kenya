const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { authenticate, requireAdmin, requireAdvocateOrAdmin, requireStaff } = require('./middleware');
const { validate } = require('./middleware/validation');
const { loginValidation, registerValidation, invitationValidation } = require('./validation/auth.validation');
const { createClientValidation } = require('./validation/client.validation');
const { createMatterValidation } = require('./validation/matter.validation');
const { generateInvoiceValidation } = require('./validation/invoice.validation');
const { genId, today, addDays, invoiceNumber, money } = require('./lib/utils');
const createDb = require('./lib/db');
const createAccess = require('./lib/access');
const createLogging = require('./lib/logging');
const createNotifications = require('./lib/notifications');
const createInvitations = require('./lib/invitations');
const createAudit = require('./lib/audit');
const { cleanDocumentName, fileTypeFor, documentListColumns, clientDocumentVisibilitySql, publicDocument, publicNotice, MAX_NOTICE_ATTACHMENTS, MAX_NOTICE_ATTACHMENT_BYTES, allowedNoticeMimeTypes, noticeMimeTypeFor, decodeAttachmentData, prepareNoticeAttachments } = require('./lib/documents');
const config = require('./lib/config');

const app = express();
const db = new sqlite3.Database(config.DATABASE_PATH);
const { run, get, all } = createDb(db);
const { canAccessMatter, canAccessNotice, canAccessConversation, canAccessDocument } = createAccess({ get });
const { logClientActivity, logAudit } = createLogging({ run });
const { notifyStaff } = createNotifications({ run, all, genId });
const { appBaseUrl, invitationUrl, checkInvitationRateLimit } = createInvitations();
const { recordAuditEvent } = createAudit({ run, get });
const JWT_SECRET = config.JWT_SECRET;

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.) in development
    if (!origin) {
      if (config.isProduction) {
        return callback(new Error('CORS: requests with no origin not allowed in production'));
      }
      return callback(null, true);
    }
    if (config.CORS_ORIGINS.length === 0) {
      if (config.isProduction) {
        return callback(new Error('CORS: no allowed origins configured in production'));
      }
      // In development, allow all
      return callback(null, true);
    }
    if (config.CORS_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(helmet({
  contentSecurityPolicy: config.CSP_REPORT_ONLY ? { reportOnly: true, directives: config.CSP_DIRECTIVES } : config.isProduction ? { directives: config.CSP_DIRECTIVES } : false,
}));
app.use(express.json({ limit: config.JSON_BODY_LIMIT }));
// Separate upload limit for document routes
app.use('/api/documents', express.json({ limit: config.UPLOAD_BODY_LIMIT }));

// General API rate limiter
const generalLimiter = rateLimit(config.rateLimitConfig(config.RATE_LIMIT_WINDOW_MS, config.RATE_LIMIT_MAX));

// Auth-specific rate limiter
const authLimiter = rateLimit(config.rateLimitConfig(config.AUTH_RATE_LIMIT_WINDOW_MS, config.AUTH_RATE_LIMIT_MAX));

// Apply general rate limiting to all API routes
app.use('/api', generalLimiter);

// Apply stricter rate limiting to auth routes
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/invitations', authLimiter);

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

const {
  defaultReminderSettings,
  defaultReminderTemplates,
  templateKey,
  defaultTemplateFor,
  seedReminderTemplates,
  renderTemplate,
  getReminderSettings,
  saveReminderSettings,
  logReminderAttempt,
  sendWhatsApp,
  sendEmail,
  sendReminderForChannel,
  sendReminder,
  runCourtReminders,
  runInvoiceReminders,
  startReminderJobs,
} = require('./lib/reminders')({ run, get, all, genId, money, defaultFirmSettings, today, addDays });
const { monthStart, sixMonthKeys, advocatePerformanceRows, cachedAdvocatePerformance, advocatePerformanceDetail } = require('./lib/performance')({ get, all, today, addDays });
const { advocateDashboard, staffDashboard } = require('./lib/dashboard')({ get, all, today });
const { getClientDashboardData } = require('./lib/clientDashboard')({ get, all, documentListColumns, clientDocumentVisibilitySql, publicDocument, publicNotice });

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

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin','client')) DEFAULT 'assistant', clientId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'Individual', contact TEXT, email TEXT, phone TEXT, status TEXT DEFAULT 'Active', joinDate TEXT, conflictCleared INTEGER DEFAULT 0, retainer REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, reference TEXT UNIQUE, clientId TEXT NOT NULL, title TEXT NOT NULL, practiceArea TEXT, stage TEXT DEFAULT 'Intake', assignedTo TEXT, paralegal TEXT, openDate TEXT, description TEXT, court TEXT, judge TEXT, caseNo TEXT, opposingCounsel TEXT, billingRate REAL DEFAULT 0, retainerBalance REAL DEFAULT 0, totalBilled REAL DEFAULT 0, priority TEXT DEFAULT 'Medium', solDate TEXT, billingType TEXT DEFAULT 'hourly', fixedFee REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, assignee TEXT, dueDate TEXT, auto_generated INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS time_entries (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, attorney TEXT, date TEXT, hours REAL DEFAULT 0, activity TEXT, description TEXT, rate REAL DEFAULT 0, billed INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS appearances (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT, date TEXT, time TEXT, type TEXT, location TEXT, meetingLink TEXT, attorney TEXT, prepNote TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT, displayName TEXT, type TEXT, mimeType TEXT, date TEXT, size TEXT, content BLOB, source TEXT DEFAULT 'firm', folderId TEXT, messageId TEXT, noticeId TEXT, clientVisible INTEGER DEFAULT 0, uploadedBy TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS case_notes (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, content TEXT NOT NULL, author TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT, number TEXT, date TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'Outstanding', dueDate TEXT, description TEXT, source TEXT DEFAULT 'time')`);
  await run(`CREATE TABLE IF NOT EXISTS invoice_items (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, timeEntryId TEXT, date TEXT, description TEXT, hours REAL DEFAULT 0, rate REAL DEFAULT 0, amount REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS integrations_log (id TEXT PRIMARY KEY, type TEXT NOT NULL, matterId TEXT, clientId TEXT, recipient TEXT, message TEXT, status TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS firm_settings (id TEXT PRIMARY KEY, name TEXT, logo TEXT, primaryColor TEXT, accentColor TEXT, websiteURL TEXT, email TEXT, phone TEXT, address TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS reminder_settings (id TEXT PRIMARY KEY, remindersEnabled INTEGER DEFAULT 1, whatsappEnabled INTEGER DEFAULT 0, emailEnabled INTEGER DEFAULT 0, twilioSid TEXT, twilioToken TEXT, twilioFromNumber TEXT, smtpHost TEXT, smtpPort TEXT, smtpUser TEXT, smtpPass TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS reminder_templates (id TEXT PRIMARY KEY, eventType TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS reminder_logs (id TEXT PRIMARY KEY, templateId TEXT, clientId TEXT, matterId TEXT, invoiceId TEXT, channel TEXT, recipient TEXT, status TEXT, sentAt TEXT, errorMessage TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS firm_notices (id TEXT PRIMARY KEY, title TEXT, content TEXT, createdAt TEXT, createdBy TEXT, clientId TEXT DEFAULT '')`);
  await run(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, matterId TEXT, clientId TEXT NOT NULL, subject TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT, senderRole TEXT, body TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS client_activity (id TEXT PRIMARY KEY, clientId TEXT, matterId TEXT, userId TEXT, action TEXT, summary TEXT, entityType TEXT, entityId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS deadlines (id TEXT PRIMARY KEY, matterId TEXT, clientId TEXT, title TEXT NOT NULL, type TEXT DEFAULT 'internal', dueDate TEXT NOT NULL, owner TEXT, status TEXT DEFAULT 'Open', notes TEXT, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS payment_proofs (id TEXT PRIMARY KEY, invoiceId TEXT, matterId TEXT, clientId TEXT, method TEXT, reference TEXT, amount REAL DEFAULT 0, note TEXT, fileName TEXT, mimeType TEXT, size TEXT, content BLOB, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, email TEXT NOT NULL, clientId TEXT, token TEXT UNIQUE NOT NULL, status TEXT DEFAULT 'pending', createdBy TEXT, createdAt TEXT, expiresAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, userId TEXT, userName TEXT, role TEXT, action TEXT, entityType TEXT, entityId TEXT, summary TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor_user_id TEXT, actor_role TEXT, actor_email TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, matter_id TEXT, client_id TEXT, ip_address TEXT, user_agent TEXT, metadata_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT, matterId TEXT, clientId TEXT, title TEXT, body TEXT, createdAt TEXT, readAt TEXT)`);

  await ensureClientUserSupport();
  await ensureColumn('appearances', 'meetingLink', 'TEXT');
  await ensureColumn('documents', 'source', "TEXT DEFAULT 'firm'");
  await ensureColumn('documents', 'folderId', 'TEXT');
  await ensureColumn('documents', 'messageId', 'TEXT');
  await ensureColumn('documents', 'noticeId', 'TEXT');
  await ensureColumn('documents', 'clientVisible', 'INTEGER DEFAULT 0');
  await ensureColumn('documents', 'displayName', 'TEXT');
  await ensureColumn('documents', 'uploadedBy', 'TEXT');
  await ensureColumn('firm_notices', 'clientId', "TEXT DEFAULT ''");
  await run("UPDATE documents SET clientVisible=1 WHERE noticeId IS NOT NULL AND noticeId<>'' AND COALESCE(clientVisible,0)<>1");
  await ensureColumn('clients', 'remindersEnabled', 'INTEGER DEFAULT 1');
  await ensureColumn('clients', 'preferredChannel', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('matters', 'remindersEnabled', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('matters', 'courtRemindersEnabled', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('matters', 'invoiceRemindersEnabled', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('reminder_logs', 'invoiceId', 'TEXT');
  await ensureColumn('time_entries', 'taskId', 'TEXT');
  await seedReminderTemplates();

  const userCount = await get('SELECT COUNT(*) AS count FROM users');
  if (!userCount.count) {
    // Use configured seed admin credentials
    const adminEmail = config.SEED_ADMIN_EMAIL;
    const adminPassword = config.SEED_ADMIN_PASSWORD;
    const adminName = config.SEED_ADMIN_NAME;
    
    // Validate password in production
    if (config.isProduction) {
      if (!adminPassword) {
        throw new Error('SEED_ADMIN_PASSWORD environment variable is required in production for initial admin setup');
      }
      const weakPasswords = ['password123', 'password', 'admin123', 'changeme', '123456', 'qwerty'];
      if (weakPasswords.includes(adminPassword.toLowerCase()) || adminPassword.length < 12) {
        throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters and not a common weak password. Please use a strong password.');
      }
    }
    
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    await run('INSERT INTO users (id,email,password,fullName,role,createdAt) VALUES (?,?,?,?,?,?)', [genId('U'), adminEmail, hashedPassword, adminName, 'admin', new Date().toISOString()]);
    if (!config.isTest) {
      console.log(`Initial admin user created: ${adminEmail}`);
      if (!config.isProduction) {
        console.log('IMPORTANT: Change the default password after first login!');
      }
    }
  }
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

async function matterFolders(matterId, req = null) {
  if (req?.user?.role === 'client') {
    const visibleCount = await get(`SELECT COUNT(*) documentCount FROM documents d WHERE d.matterId=? AND ${clientDocumentVisibilitySql('d')}`, [matterId, req.user.clientId || '']);
    const clientFolder = await get(`SELECT f.*, (SELECT COUNT(*) FROM documents d WHERE d.folderId=f.id AND ${clientDocumentVisibilitySql('d')}) documentCount
      FROM folders f
      WHERE f.matterId=? AND lower(f.name)=lower('Client Uploads')`, [req.user.clientId || '', matterId]);
    const folders = clientFolder ? [{ ...clientFolder, name: 'Client Uploads' }] : [];
    return [{ id: 'all', matterId, name: 'All Documents', virtual: true, documentCount: visibleCount?.documentCount || 0 }, ...folders];
  }
  const folders = await all(`SELECT f.*, (SELECT COUNT(*) FROM documents d WHERE d.folderId=f.id) documentCount FROM folders f WHERE f.matterId=? ORDER BY CASE WHEN lower(f.name)=lower('Client Uploads') THEN 0 ELSE 1 END, lower(f.name)`, [matterId]);
  const uncategorised = await get('SELECT COUNT(*) documentCount FROM documents WHERE matterId=? AND (folderId IS NULL OR folderId="")', [matterId]);
  return [{ id: 'all', matterId, name: 'All Documents', virtual: true }, { id: 'uncategorised', matterId, name: 'Uncategorised', virtual: true, documentCount: uncategorised.documentCount || 0 }, ...folders];
}

app.post('/api/auth/login', authLimiter, validate(loginValidation), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE lower(email)=lower(?)', [email || '']);
    if (!user || !(await bcrypt.compare(password || '', user.password || ''))) {
      // Log failed login attempt
      await recordAuditEvent(req, { action: 'login_failure', entityType: 'user', metadata: { email, reason: 'invalid credentials' } }).catch(() => {});
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.role === 'client') return res.status(403).json({ error: 'Please use the Client Portal login.' });
    const token = jwt.sign({ userId: user.id, role: user.role, fullName: user.fullName, clientId: user.clientId || '' }, JWT_SECRET, { expiresIn: '8h' });
    // Log successful login
    await recordAuditEvent(req, { action: 'login_success', entityType: 'user', entityId: user.id, metadata: { email: user.email, role: user.role } }).catch(() => {});
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, name: user.fullName, role: user.role, clientId: user.clientId || '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/client-login', authLimiter, validate(loginValidation), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE lower(email)=lower(?) AND role=?', [email || '', 'client']);
    if (!user || !(await bcrypt.compare(password || '', user.password || ''))) return res.status(401).json({ error: 'Invalid client email or password' });
    const token = jwt.sign({ userId: user.id, role: user.role, fullName: user.fullName, clientId: user.clientId || '' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, name: user.fullName, role: user.role, clientId: user.clientId || '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/firm-settings', async (req, res) => res.json(await getFirmSettings()));
app.get('/api/notices', authenticate, async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.role === 'client') {
    where = "WHERE n.clientId IS NULL OR n.clientId='' OR n.clientId=?";
    params.push(req.user.clientId || '');
  }
  const notices = await all(`SELECT n.*, c.name clientName FROM firm_notices n LEFT JOIN clients c ON c.id=n.clientId ${where} ORDER BY n.createdAt DESC`, params);
  if (!notices.length) return res.json([]);
  const ids = notices.map(n => n.id);
  const placeholders = ids.map(() => '?').join(',');
  const attachmentVisibility = req.user.role === 'client' ? ' AND COALESCE(d.clientVisible,0)=1' : '';
  const attachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.noticeId IN (${placeholders})${attachmentVisibility} ORDER BY d.date DESC, d.displayName, d.name`, ids);
  res.json(notices.map(notice => publicNotice(
    notice,
    attachments.filter(doc => doc.noticeId === notice.id).map(doc => publicDocument(doc, { client: req.user.role === 'client' })),
    req,
  )));
});
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
app.post('/api/auth/register', requireAdmin, validate(registerValidation), async (req, res) => {
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

app.post('/api/invitations', requireAdmin, validate(invitationValidation), async (req, res) => {
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

app.get('/api/audit-events', requireAdmin, async (req, res) => {
  const filters = [];
  const params = [];
  const safeFields = ['actor_user_id', 'action', 'entity_type', 'entity_id', 'matter_id', 'client_id'];
  for (const field of safeFields) {
    if (req.query[field]) {
      filters.push(`${field}=?`);
      params.push(req.query[field]);
    }
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await all(`SELECT id, timestamp, actor_user_id, actor_role, actor_email, action, entity_type, entity_id, matter_id, client_id, ip_address, metadata_json FROM audit_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const countRow = await get(`SELECT COUNT(*) count FROM audit_events ${where}`, params);
  // Parse metadata_json safely
  const sanitized = rows.map(r => ({
    ...r,
    metadata: (() => {
      try { return JSON.parse(r.metadata_json || '{}'); } catch (e) { return {}; }
    })(),
  }));
  res.json({ rows: sanitized, total: countRow.count, limit, offset });
});

app.get('/api/notifications', requireStaff, async (req, res) => {
  res.json(await all(`SELECT n.*, m.title matterTitle, m.reference, c.name clientName
    FROM notifications n
    LEFT JOIN matters m ON m.id=n.matterId
    LEFT JOIN clients c ON c.id=COALESCE(n.clientId,m.clientId)
    WHERE n.userId=? AND (n.readAt IS NULL OR n.readAt='')
    ORDER BY n.createdAt DESC
    LIMIT 50`, [req.user.userId]));
});
app.post('/api/notifications/read', requireStaff, async (req, res) => {
  const now = new Date().toISOString();
  if (req.body.matterId) {
    await run("UPDATE notifications SET readAt=? WHERE userId=? AND matterId=? AND (readAt IS NULL OR readAt='')", [now, req.user.userId, req.body.matterId]);
  } else if (req.body.id) {
    await run("UPDATE notifications SET readAt=? WHERE userId=? AND id=? AND (readAt IS NULL OR readAt='')", [now, req.user.userId, req.body.id]);
  } else {
    return res.status(400).json({ error: 'id or matterId is required' });
  }
  res.json({ ok: true });
});

app.get('/api/conversations', async (req, res) => {
  const params = [];
  const filters = [];
  if (req.user.role === 'client') {
    filters.push('conv.clientId=?');
    params.push(req.user.clientId || '');
  } else if (req.query.clientId) {
    filters.push('conv.clientId=?');
    params.push(req.query.clientId);
  }
  if (req.query.matterId) {
    filters.push('conv.matterId=?');
    params.push(req.query.matterId);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await all(`SELECT conv.*, c.name clientName, m.title matterTitle, m.reference,
      (SELECT MAX(createdAt) FROM messages msg WHERE msg.conversationId=conv.id) lastMessageAt,
      (SELECT COUNT(*) FROM messages msg WHERE msg.conversationId=conv.id) messageCount
    FROM conversations conv
    LEFT JOIN clients c ON c.id=conv.clientId
    LEFT JOIN matters m ON m.id=conv.matterId
    ${where}
    ORDER BY COALESCE(lastMessageAt, conv.createdAt) DESC`, params);
  res.json(rows);
});

app.post('/api/conversations', async (req, res) => {
  const matterId = req.body.matterId || '';
  let clientId = req.user.role === 'client' ? (req.user.clientId || '') : (req.body.clientId || '');
  if (matterId) {
    const matter = await get('SELECT id,clientId,title FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (req.user.role === 'client' && matter.clientId !== req.user.clientId) return res.status(403).json({ error: 'Matter access denied' });
    if (clientId && clientId !== matter.clientId) return res.status(400).json({ error: 'Conversation client does not match matter client' });
    clientId = matter.clientId;
  }
  if (!clientId) return res.status(400).json({ error: 'clientId or matterId is required' });
  if (req.user.role === 'client' && clientId !== req.user.clientId) return res.status(403).json({ error: 'Client access denied' });
  const client = await get('SELECT id,name FROM clients WHERE id=?', [clientId]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const id = genId('CONV');
  const subject = String(req.body.subject || '').trim() || (matterId ? 'Matter conversation' : 'General enquiry');
  await run('INSERT INTO conversations (id,matterId,clientId,subject,createdAt) VALUES (?,?,?,?,?)', [id, matterId, clientId, subject, new Date().toISOString()]);
  await logAudit(req, 'create', 'conversation', id, `Created conversation ${subject}`);
  res.json(await get(`SELECT conv.*, c.name clientName, m.title matterTitle, m.reference
    FROM conversations conv
    LEFT JOIN clients c ON c.id=conv.clientId
    LEFT JOIN matters m ON m.id=conv.matterId
    WHERE conv.id=?`, [id]));
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  if (!(await canAccessConversation(req, req.params.id))) return res.status(403).json({ error: 'Conversation access denied' });
  const messages = await all(`SELECT msg.*, u.fullName senderName
    FROM messages msg
    LEFT JOIN users u ON u.id=msg.senderId
    WHERE msg.conversationId=?
    ORDER BY msg.createdAt`, [req.params.id]);
  if (!messages.length) return res.json([]);
  const ids = messages.map(message => message.id);
  const attachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.messageId IN (${ids.map(() => '?').join(',')}) ORDER BY d.date DESC`, ids);
  res.json(messages.map(message => ({
    ...message,
    attachments: attachments.filter(doc => doc.messageId === message.id).map(publicDocument),
  })));
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  if (!(await canAccessConversation(req, req.params.id))) return res.status(403).json({ error: 'Conversation access denied' });
  const conversation = await get('SELECT conv.*, c.name clientName, m.title matterTitle FROM conversations conv LEFT JOIN clients c ON c.id=conv.clientId LEFT JOIN matters m ON m.id=conv.matterId WHERE conv.id=?', [req.params.id]);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const body = String(req.body.body || '').trim();
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  if (!body && !attachments.length) return res.status(400).json({ error: 'Message body or attachment is required' });
  const id = genId('MSG');
  await run('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)', [id, req.params.id, req.user.userId || '', req.user.role || '', body, new Date().toISOString()]);
  for (const attachment of attachments) {
    if (!attachment?.name || !attachment?.data) continue;
    const buffer = Buffer.from(String(attachment.data).split(',').pop(), 'base64');
    const mimeType = attachment.mimeType || 'application/octet-stream';
    const cleanName = cleanDocumentName(attachment.name);
    const docId = genId('DOC');
    const type = mimeType.includes('pdf') ? 'PDF' : mimeType.includes('word') || cleanName.endsWith('.doc') || cleanName.endsWith('.docx') ? 'Word' : mimeType.startsWith('image/') ? 'Image' : 'File';
    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [docId, conversation.matterId || '', cleanName, attachment.displayName || cleanName, type, mimeType, today(), `${Math.max(1, Math.round(buffer.length / 1024))} KB`, buffer, req.user.role === 'client' ? 'client' : 'firm', null, id, null, 1, req.user.userId || '']);
  }
  if (req.user.role === 'client') {
    await notifyStaff('client_message', conversation.matterId || '', 'Client sent a message', `${conversation.clientName || req.user.fullName || 'Client'}: ${body.slice(0, 160)}`, conversation.clientId || req.user.clientId || '');
    await logClientActivity({ clientId: conversation.clientId || req.user.clientId || '', matterId: conversation.matterId || '', userId: req.user.userId || '', action: 'sent_message', summary: body.slice(0, 220) || 'Sent an attachment', entityType: 'message', entityId: id });
  } else {
    await logClientActivity({ clientId: conversation.clientId || '', matterId: conversation.matterId || '', userId: req.user.userId || '', action: 'firm_sent_message', summary: body.slice(0, 220) || 'Sent an attachment', entityType: 'message', entityId: id });
  }
  await logAudit(req, 'create', 'message', id, `Added message to conversation ${conversation.subject || req.params.id}`);
  const message = await get('SELECT msg.*, u.fullName senderName FROM messages msg LEFT JOIN users u ON u.id=msg.senderId WHERE msg.id=?', [id]);
  const messageAttachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.messageId=? ORDER BY d.date DESC`, [id]);
  res.json({ ...message, attachments: messageAttachments.map(publicDocument) });
});

app.post('/api/notices', requireAdmin, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  const clientId = String(req.body.clientId || '').trim();
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  if (clientId) {
    const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
    if (!client) return res.status(400).json({ error: 'Target client not found' });
  }
  let preparedAttachments = [];
  try {
    preparedAttachments = prepareNoticeAttachments(req.body.attachments);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
  const id = genId('NOTICE');
  await run('INSERT INTO firm_notices (id,title,content,createdAt,createdBy,clientId) VALUES (?,?,?,?,?,?)', [id, title, content, new Date().toISOString(), req.user.fullName || 'Admin', clientId || '']);
  for (const attachment of preparedAttachments) {
    const docId = genId('DOC');
    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [docId, '', attachment.cleanName, attachment.displayName, attachment.type, attachment.mimeType, today(), attachment.size, attachment.buffer, 'firm', null, null, id, 1, req.user.userId || '']);
  }
  await logAudit(req, 'create', 'notice', id, `Created firm notice ${title}`);
  const notice = await get(`SELECT n.*, c.name clientName FROM firm_notices n LEFT JOIN clients c ON c.id=n.clientId WHERE n.id=?`, [id]);
  const noticeAttachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.noticeId=? ORDER BY d.date DESC`, [id]);
  res.json(publicNotice(notice, noticeAttachments.map(publicDocument), req));
});
app.delete('/api/notices/:id', requireAdmin, async (req, res) => {
  const notice = await get('SELECT * FROM firm_notices WHERE id=?', [req.params.id]);
  await run('DELETE FROM documents WHERE noticeId=?', [req.params.id]);
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
  const data = req.user.role === 'advocate'
    ? await advocateDashboard(req.user.fullName || '')
    : await staffDashboard();
  res.json(data);
});

app.get('/api/performance/advocates', requireAdmin, async (req, res) => {
  res.json(await cachedAdvocatePerformance(req.query.refresh === '1'));
});

app.get('/api/performance/advocates/:userId', requireAdmin, async (req, res) => {
  const rows = await cachedAdvocatePerformance(req.query.refresh === '1');
  const summary = rows.find(row => row.userId === req.params.userId);
  if (!summary) return res.status(404).json({ error: 'Advocate not found' });
  const detail = await advocatePerformanceDetail(summary.fullName || '');
  res.json({ ...summary, ...detail });
});

async function unifiedDeadlines() {
  const rows = [];
  const taskRows = await all(`SELECT t.id, t.title, t.dueDate, t.completed, t.assignee owner, m.id matterId, m.title matterTitle, m.reference, c.id clientId, c.name clientName
    FROM tasks t LEFT JOIN matters m ON m.id=t.matterId LEFT JOIN clients c ON c.id=m.clientId WHERE t.dueDate<>''`);
  rows.push(...taskRows.map(r => ({ id: `task:${r.id}`, sourceId: r.id, source: 'task', type: 'Internal Task', title: r.title, dueDate: r.dueDate, owner: r.owner || '', status: r.completed ? 'Done' : 'Open', matterId: r.matterId, matterTitle: r.matterTitle, reference: r.reference, clientId: r.clientId, clientName: r.clientName, notes: 'Task deadline' })));

  const appearanceRows = await all(`SELECT a.id, a.title, a.type appearanceType, a.date dueDate, a.time, a.attorney owner, m.id matterId, m.title matterTitle, m.reference, c.id clientId, c.name clientName
    FROM appearances a LEFT JOIN matters m ON m.id=a.matterId LEFT JOIN clients c ON c.id=m.clientId WHERE a.date<>''`);
  rows.push(...appearanceRows.map(r => ({ id: `appearance:${r.id}`, sourceId: r.id, source: 'appearance', type: 'Court Date', title: r.title || r.appearanceType || 'Court appearance', dueDate: r.dueDate, owner: r.owner || '', status: 'Open', matterId: r.matterId, matterTitle: r.matterTitle, reference: r.reference, clientId: r.clientId, clientName: r.clientName, notes: r.time ? `Time: ${r.time}` : 'Court appearance' })));

  const solRows = await all(`SELECT m.id matterId, m.title matterTitle, m.reference, m.solDate dueDate, m.assignedTo owner, c.id clientId, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.solDate<>''`);
  rows.push(...solRows.map(r => ({ id: `sol:${r.matterId}`, sourceId: r.matterId, source: 'matter', type: 'SOL / Limitation', title: `Limitation date: ${r.matterTitle}`, dueDate: r.dueDate, owner: r.owner || '', status: 'Open', matterId: r.matterId, matterTitle: r.matterTitle, reference: r.reference, clientId: r.clientId, clientName: r.clientName, notes: 'Statute of limitation date. Confirm the applicable law before relying on this date.' })));

  const invoiceRows = await all(`SELECT i.id, i.number, i.dueDate, i.status, i.amount, m.id matterId, m.title matterTitle, m.reference, c.id clientId, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE i.dueDate<>'' AND i.status<>'Paid'`);
  rows.push(...invoiceRows.map(r => ({ id: `invoice:${r.id}`, sourceId: r.id, source: 'invoice', type: 'Invoice Due', title: `Invoice ${r.number || r.id}`, dueDate: r.dueDate, owner: 'Accounts', status: r.status || 'Outstanding', matterId: r.matterId, matterTitle: r.matterTitle, reference: r.reference, clientId: r.clientId, clientName: r.clientName, notes: money(r.amount) })));

  const customRows = await all(`SELECT d.*, m.title matterTitle, m.reference, c.name clientName FROM deadlines d LEFT JOIN matters m ON m.id=d.matterId LEFT JOIN clients c ON c.id=COALESCE(d.clientId,m.clientId)`);
  rows.push(...customRows.map(r => ({ id: `custom:${r.id}`, sourceId: r.id, source: 'custom', type: r.type || 'Internal', title: r.title, dueDate: r.dueDate, owner: r.owner || '', status: r.status || 'Open', matterId: r.matterId, matterTitle: r.matterTitle, reference: r.reference, clientId: r.clientId, clientName: r.clientName, notes: r.notes || '' })));

  return rows.sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
}

app.get('/api/deadlines', requireStaff, async (req, res) => {
  const rows = await unifiedDeadlines();
  const type = req.query.type || '';
  const status = req.query.status || '';
  const filtered = rows.filter(row => (!type || row.type === type) && (!status || row.status === status));
  res.json(filtered);
});
app.post('/api/deadlines', requireAdvocateOrAdmin, async (req, res) => {
  const { title, dueDate, type = 'internal', matterId = '', clientId = '', owner = '', notes = '' } = req.body;
  if (!title || !dueDate) return res.status(400).json({ error: 'title and dueDate are required' });
  const id = genId('DL');
  await run('INSERT INTO deadlines (id,matterId,clientId,title,type,dueDate,owner,status,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, matterId, clientId, title, type, dueDate, owner, 'Open', notes, req.user.userId || '', new Date().toISOString()]);
  await logAudit(req, 'create', 'deadline', id, `Created ${type} deadline ${title}`);
  res.json(await get('SELECT * FROM deadlines WHERE id=?', [id]));
});
app.patch('/api/deadlines/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['title', 'type', 'dueDate', 'owner', 'status', 'notes', 'matterId', 'clientId'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE deadlines SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => req.body[f]), req.params.id]);
  const deadline = await get('SELECT * FROM deadlines WHERE id=?', [req.params.id]);
  if (deadline) await logAudit(req, 'update', 'deadline', req.params.id, `Updated deadline ${deadline.title}`);
  deadline ? res.json(deadline) : res.status(404).json({ error: 'Deadline not found' });
});
app.delete('/api/deadlines/:id', requireAdvocateOrAdmin, async (req, res) => {
  const deadline = await get('SELECT * FROM deadlines WHERE id=?', [req.params.id]);
  await run('DELETE FROM deadlines WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'deadline', req.params.id, `Deleted deadline ${deadline?.title || req.params.id}`);
  res.json({ id: req.params.id, deleted: true });
});
app.get('/api/compliance-guidance', requireStaff, async (req, res) => {
  const deadlines = await unifiedDeadlines();
  const next14 = addDays(14);
  const overdue = deadlines.filter(d => d.status !== 'Done' && d.dueDate && d.dueDate < today()).length;
  const soon = deadlines.filter(d => d.status !== 'Done' && d.dueDate >= today() && d.dueDate <= next14).length;
  const highValue = await all(`SELECT m.id,m.title,c.name clientName,m.retainerBalance,m.totalBilled FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE COALESCE(m.totalBilled,0)+COALESCE(m.retainerBalance,0) >= 1000000`);
  res.json([
    { tone: overdue ? 'danger' : 'info', title: 'Deadline control', summary: overdue ? `${overdue} overdue deadline(s) require immediate review.` : `${soon} deadline(s) fall within the next 14 days.`, action: 'Open the Deadline Center daily and mark resolved items as done.' },
    { tone: 'warning', title: 'KRA and statutory filings', summary: 'Keep monthly VAT/PAYE and annual return obligations visible as statutory deadlines.', action: 'Add recurring statutory deadlines for VAT, PAYE, NSSF/SHIF and company annual returns where applicable.' },
    { tone: highValue.length ? 'warning' : 'info', title: 'AML review', summary: highValue.length ? `${highValue.length} high-value matter(s) may need source-of-funds review.` : 'No high-value matter flags found from current billing/retainer data.', action: 'For high-value or unusual matters, record source-of-funds notes and KYC documents before proceeding.' },
    { tone: 'info', title: 'Limitation dates', summary: 'SOL dates are guidance fields and must be checked against the applicable statute and facts.', action: 'Confirm limitation periods during intake and add a statutory deadline where necessary.' },
  ]);
});

app.get('/api/clients', requireStaff, async (req, res) => res.json(await all('SELECT * FROM clients ORDER BY name')));
app.post('/api/clients', requireStaff, validate(createClientValidation), async (req, res) => {
  const id = genId('C');
  await run('INSERT INTO clients (id,name,type,contact,email,phone,status,joinDate,conflictCleared,retainer,remindersEnabled,preferredChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, req.body.name, req.body.type || 'Individual', req.body.contact || '', req.body.email || '', req.body.phone || '', 'Active', today(), 0, Number(req.body.retainer || 0), req.body.remindersEnabled === undefined ? 1 : (req.body.remindersEnabled ? 1 : 0), req.body.preferredChannel || 'firm_default']);
  const client = await get('SELECT * FROM clients WHERE id=?', [id]);
  await logAudit(req, 'create', 'client', id, `Created client ${client.name}`);
  res.json(client);
});
app.patch('/api/clients/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['name', 'type', 'contact', 'email', 'phone', 'status', 'conflictCleared', 'retainer', 'remindersEnabled', 'preferredChannel'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE clients SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => f === 'retainer' ? Number(req.body[f] || 0) : f === 'remindersEnabled' ? (req.body[f] ? 1 : 0) : req.body[f]), req.params.id]);
  const client = await get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (client) await logAudit(req, 'update', 'client', req.params.id, `Updated client ${client.name}`);
  client ? res.json(client) : res.status(404).json({ error: 'Client not found' });
});
app.get('/api/clients/:id/activity', requireStaff, async (req, res) => {
  const client = await get('SELECT id FROM clients WHERE id=?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
  res.json(await all(`SELECT ca.*, m.title matterTitle, m.reference, u.fullName userName
    FROM client_activity ca
    LEFT JOIN matters m ON m.id=ca.matterId
    LEFT JOIN users u ON u.id=ca.userId
    WHERE ca.clientId=?
    ORDER BY ca.createdAt DESC
    LIMIT ?`, [req.params.id, limit]));
});
app.delete('/api/clients/:id', requireAdvocateOrAdmin, async (req, res) => {
  const client = await get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  const matters = await all('SELECT id FROM matters WHERE clientId=?', [req.params.id]);
  await run('BEGIN TRANSACTION');
  try {
    for (const matter of matters) await deleteMatterCascade(matter.id);
    const conversations = await all('SELECT id FROM conversations WHERE clientId=?', [req.params.id]);
    for (const conversation of conversations) await run('DELETE FROM messages WHERE conversationId=?', [conversation.id]);
    await run('DELETE FROM conversations WHERE clientId=?', [req.params.id]);
    await run('DELETE FROM client_activity WHERE clientId=?', [req.params.id]);
    await run('DELETE FROM deadlines WHERE clientId=?', [req.params.id]);
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
  if (req.user.role === 'advocate') return res.json(await all('SELECT m.*, c.name clientName, (SELECT MIN(date) FROM appearances a WHERE a.matterId=m.id AND a.date>=?) nextCourtDate FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.assignedTo=? ORDER BY openDate DESC', [today(), req.user.fullName || '']));
  res.json(await all('SELECT m.*, c.name clientName, (SELECT MIN(date) FROM appearances a WHERE a.matterId=m.id AND a.date>=?) nextCourtDate FROM matters m LEFT JOIN clients c ON c.id=m.clientId ORDER BY openDate DESC', [today()]));
});
app.get('/api/matters/:id', async (req, res) => {
  const matter = await get('SELECT m.*, c.name clientName, c.email clientEmail, c.phone clientPhone FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  if (req.user.role === 'client' && matter.clientId !== req.user.clientId) return res.status(403).json({ error: 'Matter access denied' });
  const documentParams = [req.params.id];
  let documentWhere = 'd.matterId=?';
  if (req.user.role === 'client') {
    documentWhere += ` AND ${clientDocumentVisibilitySql('d')}`;
    documentParams.push(req.user.clientId || '');
  }
  const [tasks, timeEntries, documents, notes, invoices, appearances] = await Promise.all([
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM tasks WHERE matterId=? ORDER BY dueDate', [req.params.id]),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM time_entries WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE ${documentWhere} ORDER BY d.date DESC`, documentParams),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id]),
    all('SELECT * FROM invoices WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT * FROM appearances WHERE matterId=? ORDER BY date', [req.params.id])
  ]);
  res.json({ ...matter, tasks, timeEntries, documents: documents.map(publicDocument), notes, invoices, appearances });
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
app.post('/api/matters', requireAdvocateOrAdmin, validate(createMatterValidation), async (req, res) => {
  const id = genId('M');
  const reference = req.body.reference || `LEX-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
  await run(`INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,paralegal,openDate,description,court,judge,caseNo,opposingCounsel,billingRate,retainerBalance,totalBilled,priority,solDate,billingType,fixedFee,remindersEnabled,courtRemindersEnabled,invoiceRemindersEnabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, reference, req.body.clientId, req.body.title, req.body.practiceArea || '', req.body.stage || 'Intake', req.body.assignedTo || '', req.body.paralegal || '', req.body.openDate || today(), req.body.description || '', req.body.court || '', req.body.judge || '', req.body.caseNo || '', req.body.opposingCounsel || '', Number(req.body.billingRate || 0), Number(req.body.retainerBalance || 0), 0, req.body.priority || 'Medium', req.body.solDate || '', req.body.billingType || 'hourly', Number(req.body.fixedFee || 0), req.body.remindersEnabled || 'firm_default', req.body.courtRemindersEnabled || 'firm_default', req.body.invoiceRemindersEnabled || 'firm_default']);
  const matter = await get('SELECT * FROM matters WHERE id=?', [id]);
  await logAudit(req, 'create', 'matter', id, `Created matter ${matter.title} (${matter.reference})`);
  res.json(matter);
});
app.patch('/api/matters/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['reference','clientId','title','practiceArea','stage','assignedTo','paralegal','openDate','description','court','judge','caseNo','opposingCounsel','priority','billingRate','billingType','fixedFee','retainerBalance','totalBilled','solDate','remindersEnabled','courtRemindersEnabled','invoiceRemindersEnabled'];
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
  const conversations = await all('SELECT id FROM conversations WHERE matterId=?', [matterId]);
  for (const conversation of conversations) await run('DELETE FROM messages WHERE conversationId=?', [conversation.id]);
  await run('DELETE FROM conversations WHERE matterId=?', [matterId]);
  await run('DELETE FROM invoices WHERE matterId=?', [matterId]);
  await run('DELETE FROM tasks WHERE matterId=?', [matterId]);
  await run('DELETE FROM time_entries WHERE matterId=?', [matterId]);
  await run('DELETE FROM appearances WHERE matterId=?', [matterId]);
  await run('DELETE FROM documents WHERE matterId=?', [matterId]);
  await run('DELETE FROM folders WHERE matterId=?', [matterId]);
  await run('DELETE FROM case_notes WHERE matterId=?', [matterId]);
  await run('DELETE FROM integrations_log WHERE matterId=?', [matterId]);
  await run('DELETE FROM payment_proofs WHERE matterId=?', [matterId]);
  await run('DELETE FROM deadlines WHERE matterId=?', [matterId]);
  await run('DELETE FROM notifications WHERE matterId=?', [matterId]);
  await run('DELETE FROM client_activity WHERE matterId=?', [matterId]);
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
app.post('/api/time-entries', requireStaff, async (req, res) => {
  const taskId = req.body.taskId || '';
  if (taskId) {
    const task = await get('SELECT id,matterId,title FROM tasks WHERE id=?', [taskId]);
    if (!task) return res.status(400).json({ error: 'Task not found' });
    if (task.matterId !== req.body.matterId) return res.status(400).json({ error: 'Task does not belong to this matter' });
  }
  const id = genId('TIME');
  await run('INSERT INTO time_entries (id,matterId,taskId,attorney,date,hours,activity,description,rate,billed) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, taskId, req.body.attorney || req.user.fullName || '', req.body.date || today(), Number(req.body.hours || 0), req.body.activity || '', req.body.description || '', Number(req.body.rate || 0), req.body.billed ? 1 : 0]);
  const entry = await get('SELECT * FROM time_entries WHERE id=?', [id]);
  await logAudit(req, 'create', 'time_entry', id, `Logged ${entry.hours} hour(s) for matter ${entry.matterId}${entry.taskId ? ` task ${entry.taskId}` : ''}`);
  res.json(entry);
});
app.patch('/api/time-entries/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['matterId','taskId','attorney','date','hours','activity','description','rate','billed'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  if (req.body.taskId) {
    const matterId = req.body.matterId || (await get('SELECT matterId FROM time_entries WHERE id=?', [req.params.id]))?.matterId;
    const task = await get('SELECT id,matterId FROM tasks WHERE id=?', [req.body.taskId]);
    if (!task) return res.status(400).json({ error: 'Task not found' });
    if (task.matterId !== matterId) return res.status(400).json({ error: 'Task does not belong to this matter' });
  }
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
  res.json(await matterFolders(req.params.id, req));
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
  if (req.user.role === 'client') {
    where += ` AND ${clientDocumentVisibilitySql('d')}`;
    params.push(req.user.clientId || '');
  }
  const docs = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE ${where} ORDER BY d.date DESC, COALESCE(d.displayName,d.name)`, params);
  res.json(docs.map(publicDocument));
});
app.post('/api/matters/:id/documents', async (req, res) => {
  if (req.user.role === 'client') {
    if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' });
  } else if (!['advocate', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Advocate or admin access required' });
  }
  const { name, mimeType, data, displayName } = req.body;
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
  const cleanName = cleanDocumentName(name);
  const cleanDisplayName = displayName ? cleanDocumentName(displayName) : cleanName;
  const clientVisible = req.user.role === 'client' ? 0 : (req.body.clientVisible ? 1 : 0);
  await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, req.params.id, cleanName, cleanDisplayName, type, mimeType, today(), `${Math.max(1, Math.round(buffer.length / 1024))} KB`, buffer, source, folderId || null, null, null, clientVisible, req.user.userId || '']);
  const doc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [id]);
  await logAudit(req, 'upload', 'document', id, `Uploaded document ${doc.name}`);
  if (req.user.role === 'client') {
    const matter = await get('SELECT m.title, m.reference, c.id clientId, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
    await notifyStaff('client_document', req.params.id, 'Client uploaded a document', `${matter?.clientName || req.user.fullName || 'Client'} uploaded ${doc.name} for ${matter?.title || 'a matter'}.`, matter?.clientId || req.user.clientId || '');
    await logClientActivity({ clientId: matter?.clientId || req.user.clientId || '', matterId: req.params.id, userId: req.user.userId || '', action: 'uploaded_document', summary: `Uploaded ${doc.displayName || doc.name}`, entityType: 'document', entityId: id });
  }
  res.json(publicDocument(doc));
});
app.get('/api/documents/:id/download', async (req, res) => {
  const doc = await get('SELECT * FROM documents WHERE id=?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!(await canAccessDocument(req, doc))) return res.status(403).json({ error: 'Document access denied' });
  if (req.user.role === 'client') {
    await logClientActivity({ clientId: req.user.clientId || '', matterId: doc.matterId || '', userId: req.user.userId || '', action: 'downloaded_document', summary: `Downloaded ${doc.displayName || doc.name || req.params.id}`, entityType: 'document', entityId: req.params.id });
  }
  res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${cleanDocumentName(doc.displayName || doc.name)}"`);
  res.send(doc.content);
});
app.patch('/api/documents/:id', requireAdvocateOrAdmin, async (req, res) => {
  const doc = await get('SELECT * FROM documents WHERE id=?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const updates = [];
  const values = [];
  if (req.body.folderId !== undefined) {
    let folderId = req.body.folderId || '';
    if (folderId && folderId !== 'uncategorised' && folderId !== 'all') {
      const folder = await get('SELECT id FROM folders WHERE id=? AND matterId=?', [folderId, doc.matterId]);
      if (!folder) return res.status(400).json({ error: 'Folder not found for this matter' });
    } else folderId = null;
    updates.push('folderId=?');
    values.push(folderId);
  }
  if (req.body.clientVisible !== undefined) {
    updates.push('clientVisible=?');
    values.push(req.body.clientVisible ? 1 : 0);
  }
  if (req.body.displayName !== undefined) {
    updates.push('displayName=?');
    values.push(cleanDocumentName(req.body.displayName || doc.name));
  }
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE documents SET ${updates.join(',')} WHERE id=?`, [...values, req.params.id]);
  await logAudit(req, 'update', 'document', req.params.id, `Updated document ${doc.name}`);
  const updated = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [req.params.id]);
  res.json(publicDocument(updated));
});
app.delete('/api/documents/:id', requireAdvocateOrAdmin, async (req, res) => { const doc = await get('SELECT id,name,matterId FROM documents WHERE id=?', [req.params.id]); await run('DELETE FROM documents WHERE id=?', [req.params.id]); await logAudit(req, 'delete', 'document', req.params.id, `Deleted document ${doc?.name || req.params.id}`); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/matters/:id/notes', async (req, res) => { if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' }); if (req.user.role === 'client') return res.json([]); res.json(await all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id])); });
app.post('/api/matters/:id/notes', async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' });
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Note content is required' });
  const id = genId('NOTE');
  const author = req.user.role === 'client' ? req.user.fullName : (req.body.author || req.user.fullName || 'Unknown');
  await run('INSERT INTO case_notes (id,matterId,content,author,createdAt) VALUES (?,?,?,?,?)', [id, req.params.id, content, author, new Date().toISOString()]);
  const note = await get('SELECT * FROM case_notes WHERE id=?', [id]);
  if (req.user.role === 'client') {
    const matter = await get('SELECT m.title, m.reference, c.id clientId, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
    await notifyStaff('client_message', req.params.id, 'Client sent a message', `${matter?.clientName || author || 'Client'}: ${content.slice(0, 160)}`, matter?.clientId || req.user.clientId || '');
    await logClientActivity({ clientId: matter?.clientId || req.user.clientId || '', matterId: req.params.id, userId: req.user.userId || '', action: 'sent_message', summary: content.slice(0, 220), entityType: 'case_note', entityId: id });
  }
  res.json(note);
});

app.get('/api/invoices', async (req, res) => {
  if (req.user.role === 'client') return res.json(await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE i.clientId=? ORDER BY i.date DESC, i.number DESC`, [req.user.clientId || '']));
  if (req.user.role === 'advocate') return res.json(await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE m.assignedTo=? ORDER BY i.date DESC, i.number DESC`, [req.user.fullName || '']));
  res.json(await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId ORDER BY i.date DESC, i.number DESC`));
});
app.post('/api/invoices/generate', requireAdvocateOrAdmin, validate(generateInvoiceValidation), async (req, res) => {
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
  const data = await getClientDashboardData(req.user.clientId || '', req);
  res.json(data);
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
  if (req.user.role === 'advocate') {
    const name = req.user.fullName || '';
    const matters = await all(`SELECT m.id,m.title,m.reference,c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.assignedTo=? AND (m.title LIKE ? OR m.reference LIKE ? OR c.name LIKE ?) LIMIT 5`, [name, q, q, q]);
    const clients = await all(`SELECT DISTINCT c.id,c.name,c.email,c.phone FROM clients c INNER JOIN matters m ON m.clientId=c.id WHERE m.assignedTo=? AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?) LIMIT 5`, [name, q, q, q]);
    const tasks = await all(`SELECT t.id,t.title,t.assignee,t.matterId FROM tasks t WHERE t.assignee=? AND (t.title LIKE ? OR t.assignee LIKE ?) LIMIT 5`, [name, q, q]);
    const invoices = await all(`SELECT i.id,i.number,i.description,i.status,i.matterId FROM invoices i INNER JOIN matters m ON m.id=i.matterId WHERE m.assignedTo=? AND (i.number LIKE ? OR i.description LIKE ? OR i.status LIKE ?) LIMIT 5`, [name, q, q, q]);
    const appearances = await all(`SELECT a.id,a.title,a.date,a.time,a.type,a.location,a.attorney,a.matterId FROM appearances a LEFT JOIN matters m ON m.id=a.matterId WHERE (a.attorney=? OR m.assignedTo=?) AND (a.title LIKE ? OR a.location LIKE ? OR a.type LIKE ?) LIMIT 5`, [name, name, q, q, q]);
    const documents = await all(`SELECT d.id,d.displayName,d.name,d.type,d.matterId FROM documents d INNER JOIN matters m ON m.id=d.matterId WHERE m.assignedTo=? AND (d.displayName LIKE ? OR d.name LIKE ?) LIMIT 5`, [name, q, q]);
    const conversations = await all(`SELECT conv.id,conv.matterId,conv.subject,m.title matterTitle FROM conversations conv INNER JOIN matters m ON m.id=conv.matterId WHERE m.assignedTo=? AND conv.subject LIKE ? LIMIT 5`, [name, q]);
    return res.json([
      ...matters.map(m => ({ type: 'Matter', id: m.id, matterId: m.id, title: m.title, subtitle: `${m.reference || ''} ${m.clientName || ''}`.trim() })),
      ...clients.map(c => ({ type: 'Client', id: c.id, title: c.name, subtitle: `${c.email || ''} ${c.phone || ''}`.trim() })),
      ...tasks.map(t => ({ type: 'Task', id: t.id, matterId: t.matterId, title: t.title, subtitle: `Assigned to ${t.assignee || '-'}` })),
      ...invoices.map(i => ({ type: 'Invoice', id: i.id, matterId: i.matterId, title: i.number, subtitle: `${i.description || i.status || ''}`.trim() })),
      ...appearances.map(a => ({ type: 'Appearance', id: a.id, matterId: a.matterId, title: a.title, subtitle: `${a.date || ''} ${a.time || ''} ${a.location || ''}`.trim() })),
      ...documents.map(d => ({ type: 'Document', id: d.id, matterId: d.matterId, title: d.displayName || d.name, subtitle: d.type || 'File' })),
      ...conversations.map(conversation => ({ type: 'Conversation', id: conversation.id, matterId: conversation.matterId, title: conversation.subject, subtitle: conversation.matterTitle ? `Matter: ${conversation.matterTitle}` : 'Conversation' })),
    ]);
  }
  const matters = await all(`SELECT m.id,m.title,m.reference,c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.title LIKE ? OR m.reference LIKE ? OR c.name LIKE ? LIMIT 5`, [q, q, q]);
  const clients = await all('SELECT id,name,email,phone FROM clients WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 5', [q, q, q]);
  const tasks = await all(`SELECT id,title,assignee,matterId FROM tasks WHERE title LIKE ? OR assignee LIKE ? LIMIT 5`, [q, q]);
  const invoices = await all(`SELECT id,number,description,status,matterId FROM invoices WHERE number LIKE ? OR description LIKE ? OR status LIKE ? LIMIT 5`, [q, q, q]);
  const appearances = await all(`SELECT id,title,date,time,type,location,attorney,matterId FROM appearances WHERE title LIKE ? OR location LIKE ? OR type LIKE ? LIMIT 5`, [q, q, q]);
  const documents = await all(`SELECT id,displayName,name,type,matterId FROM documents WHERE displayName LIKE ? OR name LIKE ? LIMIT 5`, [q, q]);
  const conversations = await all(`SELECT conv.id,conv.matterId,conv.subject,m.title matterTitle FROM conversations conv LEFT JOIN matters m ON m.id=conv.matterId WHERE conv.subject LIKE ? LIMIT 5`, [q]);
  res.json([
    ...matters.map(m => ({ type: 'Matter', id: m.id, matterId: m.id, title: m.title, subtitle: `${m.reference || ''} ${m.clientName || ''}`.trim() })),
    ...clients.map(c => ({ type: 'Client', id: c.id, title: c.name, subtitle: `${c.email || ''} ${c.phone || ''}`.trim() })),
    ...tasks.map(t => ({ type: 'Task', id: t.id, matterId: t.matterId, title: t.title, subtitle: `Assigned to ${t.assignee || '-'}` })),
    ...invoices.map(i => ({ type: 'Invoice', id: i.id, matterId: i.matterId, title: i.number, subtitle: `${i.description || i.status || ''}`.trim() })),
    ...appearances.map(a => ({ type: 'Appearance', id: a.id, matterId: a.matterId, title: a.title, subtitle: `${a.date || ''} ${a.time || ''} ${a.location || ''}`.trim() })),
    ...documents.map(d => ({ type: 'Document', id: d.id, matterId: d.matterId, title: d.displayName || d.name, subtitle: d.type || 'File' })),
    ...conversations.map(conversation => ({ type: 'Conversation', id: conversation.id, matterId: conversation.matterId, title: conversation.subject, subtitle: conversation.matterTitle ? `Matter: ${conversation.matterTitle}` : 'Conversation' })),
  ]);
});

app.post('/api/mpesa/stk-push', requireStaff, async (req, res) => { const id = genId('MPESA'); await run('INSERT INTO integrations_log (id,type,matterId,clientId,recipient,message,status,createdAt) VALUES (?,?,?,?,?,?,?,?)', [id, 'mpesa', req.body.matterId || '', req.body.clientId || '', req.body.phone || '', `STK push amount ${req.body.amount}`, 'Queued', new Date().toISOString()]); res.json({ id, status: 'Queued', checkoutRequestId: `ws_CO_${Date.now()}`, message: 'STK push queued. Add Daraja credentials for live payments.' }); });
app.post('/api/whatsapp/reminders', requireStaff, async (req, res) => { const rows = await all(`SELECT a.*,m.clientId,m.title matterTitle,c.name clientName,c.phone FROM appearances a LEFT JOIN matters m ON m.id=a.matterId LEFT JOIN clients c ON c.id=m.clientId WHERE a.date BETWEEN ? AND ?`, [today(), addDays(Number(req.body.days || 3))]); const reminders = rows.map(r => ({ id: genId('WA'), matterId: r.matterId, clientName: r.clientName, phone: r.phone, message: `Reminder: ${r.title} for ${r.matterTitle} is on ${r.date} at ${r.time || 'TBA'}.`, status: r.phone ? 'Queued' : 'Missing phone' })); res.json({ count: reminders.length, reminders }); });
app.get('/api/exports/:type.:format', requireStaff, async (req, res) => { const rows = req.params.type === 'itax' ? await all(`SELECT i.number,i.date,c.name client,i.amount,i.status FROM invoices i LEFT JOIN clients c ON c.id=i.clientId`) : await all(`SELECT m.reference,m.title,c.name client,m.practiceArea,m.stage,m.totalBilled FROM matters m LEFT JOIN clients c ON c.id=m.clientId`); if (req.params.format === 'pdf') { const doc = new PDFDocument(); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-report.pdf"`); doc.pipe(res); doc.fontSize(18).text(`${req.params.type.toUpperCase()} Report`); rows.forEach(r => doc.fontSize(10).text(Object.values(r).join(' | '))); doc.end(); } else { res.setHeader('Content-Type', 'application/vnd.ms-excel'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-report.xls"`); res.send(rows.map(r => Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')); } });

module.exports = { app, config };

if (require.main === module) {
  initDb().then(() => {
    app.listen(config.PORT, () => {
      console.log(`LexFlow Kenya server running at http://localhost:${config.PORT}`);
      startReminderJobs(getFirmSettings);
    });
  }).catch(err => {
    console.error('Database initialisation failed', err);
    process.exit(1);
  });
}
