const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./lib/passwords');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument, degrees, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');
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
const { cleanDocumentName, fileTypeFor, documentListColumns, documentMetadataColumns, clientDocumentVisibilitySql, publicDocument, publicNotice, MAX_NOTICE_ATTACHMENTS, MAX_NOTICE_ATTACHMENT_BYTES, allowedNoticeMimeTypes, noticeMimeTypeFor, decodeAttachmentData, prepareNoticeAttachments } = require('./lib/documents');
const config = require('./lib/config');
const { signAccessToken } = require('./lib/tokens');
const { validatePasswordPolicy } = require('./lib/passwordPolicy');
const createOAuth = require('./lib/oauth');
const { signState, verifyState } = require('./lib/oauthState');
const googleOAuth = require('./lib/oauthGoogle');
const microsoftOAuth = require('./lib/oauthMicrosoft');
const themeValidation = require('./lib/themeValidation');
const { buildTemplateMergeContext, mergeTemplateMarkup } = require('./lib/templateMerge');

const app = express();
const db = new sqlite3.Database(config.DATABASE_PATH);
const { run, get, all } = createDb(db);
const { canAccessMatter, canAccessClient, canAccessInvoice, canAccessTask, canAccessTimeEntry, canAccessAppearance, canAccessNotice, canAccessConversation, canAccessDocument, canAccessDocumentRequest, isBillingVisibleFor } = createAccess({ get });
const { logClientActivity, logAudit } = createLogging({ run });
const { notifyStaff } = createNotifications({ run, all, genId });
const { appBaseUrl, invitationUrl, checkInvitationRateLimit } = createInvitations();
const { recordAuditEvent } = createAudit({ run, get });
const oauth = createOAuth({ run, get, all });
const CONVERSATION_STATUSES = new Set(['open', 'pending', 'resolved']);
const WORK_EMAIL_SYNC_TYPE = 'email_metadata';
const WORK_CALENDAR_SYNC_TYPE = 'calendar_metadata';
const WORK_EMAIL_SYNC_LIMIT = 25;
const GENERIC_EMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com']);
const MAX_MERGE_PDF_COUNT = 10;
const MAX_MERGE_PDF_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACT_PDF_PAGES = 250;
const MAX_DELETE_PDF_PAGES = 250;

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

app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

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
  paymentInstructions: '',
  kraPin: '',
  vatNumber: '',
  invoiceFooterNote: '',
  defaultInvoiceDueDays: 30,
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
const { advocateDashboard, staffDashboard } = require('./lib/dashboard')({ get, all, today, isBillingVisibleFor });
const { getClientDashboardData } = require('./lib/clientDashboard')({ get, all, documentListColumns, clientDocumentVisibilitySql, publicDocument, publicNotice });

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some(existing => existing.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizeBillable(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  return null;
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
  let theme = null;
  if (settings?.themeJson) {
    try {
      theme = JSON.parse(settings.themeJson);
    } catch {
      theme = null;
    }
  }
  const normalized = { ...defaultFirmSettings, ...(settings || {}) };
  normalized.defaultInvoiceDueDays = normalizeDefaultInvoiceDueDays(normalized.defaultInvoiceDueDays);
  return { ...normalized, reminderSettings, theme: theme || null };
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin','client')) DEFAULT 'assistant', clientId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'Individual', contact TEXT, email TEXT, phone TEXT, status TEXT DEFAULT 'Active', joinDate TEXT, conflictCleared INTEGER DEFAULT 0, retainer REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, reference TEXT UNIQUE, clientId TEXT NOT NULL, title TEXT NOT NULL, practiceArea TEXT, stage TEXT DEFAULT 'Intake', assignedTo TEXT, paralegal TEXT, openDate TEXT, description TEXT, court TEXT, judge TEXT, caseNo TEXT, opposingCounsel TEXT, billingRate REAL DEFAULT 0, retainerBalance REAL DEFAULT 0, totalBilled REAL DEFAULT 0, priority TEXT DEFAULT 'Medium', solDate TEXT, billingType TEXT DEFAULT 'hourly', fixedFee REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, assignee TEXT, dueDate TEXT, auto_generated INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS time_entries (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, attorney TEXT, date TEXT, hours REAL DEFAULT 0, activity TEXT, description TEXT, rate REAL DEFAULT 0, billed INTEGER DEFAULT 0, billable INTEGER DEFAULT 1)`);
  await run(`CREATE TABLE IF NOT EXISTS appearances (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT, date TEXT, time TEXT, type TEXT, location TEXT, meetingLink TEXT, attorney TEXT, prepNote TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT, displayName TEXT, type TEXT, mimeType TEXT, date TEXT, size TEXT, content BLOB, source TEXT DEFAULT 'firm', folderId TEXT, messageId TEXT, noticeId TEXT, clientVisible INTEGER DEFAULT 0, uploadedBy TEXT, templateId TEXT, templateName TEXT, generatedBy TEXT, generatedAt TEXT, version INTEGER DEFAULT 1)`);
  await run(`CREATE TABLE IF NOT EXISTS case_notes (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, content TEXT NOT NULL, author TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT, number TEXT, date TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'Outstanding', dueDate TEXT, description TEXT, source TEXT DEFAULT 'time')`);
  await run(`CREATE TABLE IF NOT EXISTS invoice_items (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, timeEntryId TEXT, date TEXT, description TEXT, hours REAL DEFAULT 0, rate REAL DEFAULT 0, amount REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, matterId TEXT NOT NULL, clientId TEXT NOT NULL, amount REAL NOT NULL, method TEXT, reference TEXT, date TEXT NOT NULL, note TEXT, proofId TEXT, createdBy TEXT, createdAt TEXT NOT NULL)`);
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
  await run(`CREATE TABLE IF NOT EXISTS oauth_accounts (id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT CHECK(provider IN ('google','microsoft')) NOT NULL, providerSubject TEXT NOT NULL, email TEXT NOT NULL, emailVerified INTEGER DEFAULT 0, revokedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastLoginAt TEXT, UNIQUE(provider, providerSubject))`);
  await run(`CREATE TABLE IF NOT EXISTS connected_accounts (id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')), providerAccountId TEXT, email TEXT, displayName TEXT, scopes TEXT, status TEXT NOT NULL DEFAULT 'connected', connectedAt TEXT NOT NULL, disconnectedAt TEXT, lastSyncAt TEXT, lastError TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS connected_account_tokens (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, accessTokenEncrypted TEXT, refreshTokenEncrypted TEXT, tokenType TEXT, expiresAt TEXT, scope TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS work_email_messages (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, userId TEXT NOT NULL, provider TEXT NOT NULL, providerAccountId TEXT, providerMessageId TEXT NOT NULL, providerThreadId TEXT, sender TEXT, recipientsSummary TEXT, subject TEXT, snippet TEXT, receivedAt TEXT, hasAttachments INTEGER DEFAULT 0, labelsJson TEXT, foldersJson TEXT, matchedMatterId TEXT, matchConfidence REAL, matchReason TEXT, importedAt TEXT NOT NULL, updatedAt TEXT, UNIQUE(connectedAccountId, providerMessageId))`);
  await run(`CREATE TABLE IF NOT EXISTS connected_account_sync_state (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, syncType TEXT NOT NULL, cursorJson TEXT, lastAttemptAt TEXT, lastSuccessAt TEXT, lastError TEXT, lastImportedCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT, UNIQUE(connectedAccountId, syncType))`);
  await run(`CREATE TABLE IF NOT EXISTS work_calendar_events (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, userId TEXT NOT NULL, provider TEXT NOT NULL, providerAccountId TEXT, providerEventId TEXT NOT NULL, calendarId TEXT, calendarName TEXT, subject TEXT, startTime TEXT, endTime TEXT, location TEXT, meetingLink TEXT, organizer TEXT, attendeesSummary TEXT, descriptionSnippet TEXT, providerUpdatedAt TEXT, matchedMatterId TEXT, matchConfidence REAL, matchReason TEXT, importedAt TEXT NOT NULL, updatedAt TEXT, UNIQUE(connectedAccountId, providerEventId))`);
  await run(`CREATE TABLE IF NOT EXISTS work_metadata_matter_links (id TEXT PRIMARY KEY, sourceType TEXT NOT NULL, sourceId TEXT NOT NULL, matterId TEXT NOT NULL, suggestedMatterId TEXT, confidence REAL, reason TEXT, status TEXT NOT NULL, confirmedBy TEXT, confirmedAt TEXT, unlinkedBy TEXT, unlinkedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS matter_checklist_items (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, position INTEGER DEFAULT 0, notes TEXT, dueDate TEXT, assignee TEXT, createdBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT, completedAt TEXT, completedBy TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS checklist_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, practiceArea TEXT, active INTEGER DEFAULT 1, createdBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS checklist_template_items (id TEXT PRIMARY KEY, templateId TEXT NOT NULL, title TEXT NOT NULL, notes TEXT, position INTEGER DEFAULT 0, createdAt TEXT NOT NULL)`);
  await run(`CREATE TABLE IF NOT EXISTS document_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, practiceArea TEXT, category TEXT, bodyMarkup TEXT, active INTEGER DEFAULT 1, createdBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS document_requests (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT NOT NULL, staffUserId TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'pending', createdAt TEXT NOT NULL, respondedAt TEXT, responseDocumentId TEXT, cancelledAt TEXT, cancelledBy TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS signature_assets (id TEXT PRIMARY KEY, ownerType TEXT NOT NULL CHECK(ownerType IN ('user','firm')), ownerId TEXT, assetType TEXT NOT NULL CHECK(assetType IN ('signature','stamp')), label TEXT NOT NULL, mimeType TEXT NOT NULL, content BLOB NOT NULL, size INTEGER, isDefault INTEGER DEFAULT 0, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT, deletedAt TEXT)`);

  await ensureClientUserSupport();
  await ensureColumn('matter_checklist_items', 'dueDate', 'TEXT');
  await ensureColumn('matter_checklist_items', 'assignee', 'TEXT');
  await ensureColumn('matter_checklist_items', 'updatedAt', 'TEXT');
  await ensureColumn('users', 'tokenVersion', 'INTEGER DEFAULT 1');
  await ensureColumn('appearances', 'meetingLink', 'TEXT');
  await ensureColumn('documents', 'source', "TEXT DEFAULT 'firm'");
  await ensureColumn('documents', 'folderId', 'TEXT');
  await ensureColumn('documents', 'messageId', 'TEXT');
  await ensureColumn('documents', 'noticeId', 'TEXT');
  await ensureColumn('documents', 'clientVisible', 'INTEGER DEFAULT 0');
  await ensureColumn('documents', 'displayName', 'TEXT');
  await ensureColumn('documents', 'uploadedBy', 'TEXT');
  await ensureColumn('documents', 'deletedAt', 'TEXT');
  await ensureColumn('documents', 'templateId', 'TEXT');
  await ensureColumn('documents', 'templateName', 'TEXT');
  await ensureColumn('documents', 'generatedBy', 'TEXT');
  await ensureColumn('documents', 'generatedAt', 'TEXT');
  await ensureColumn('documents', 'version', 'INTEGER DEFAULT 1');
  await ensureColumn('conversations', 'status', "TEXT DEFAULT 'open'");
  await ensureColumn('conversations', 'lastStaffReadAt', 'TEXT');
  await ensureColumn('conversations', 'lastClientReadAt', 'TEXT');
  await ensureColumn('conversations', 'statusUpdatedAt', 'TEXT');
  await run("UPDATE conversations SET status='open' WHERE status IS NULL OR status=''");
  await run("UPDATE conversations SET lastStaffReadAt=COALESCE((SELECT MAX(createdAt) FROM messages msg WHERE msg.conversationId=conversations.id),'') WHERE lastStaffReadAt IS NULL");
  await run("UPDATE conversations SET lastClientReadAt=COALESCE((SELECT MAX(createdAt) FROM messages msg WHERE msg.conversationId=conversations.id),'') WHERE lastClientReadAt IS NULL");
  await ensureColumn('firm_notices', 'clientId', "TEXT DEFAULT ''");
  await run("UPDATE documents SET clientVisible=1 WHERE noticeId IS NOT NULL AND noticeId<>'' AND COALESCE(clientVisible,0)<>1");
  await ensureColumn('clients', 'remindersEnabled', 'INTEGER DEFAULT 1');
  await ensureColumn('clients', 'preferredChannel', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('matters', 'remindersEnabled', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('matters', 'courtRemindersEnabled', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('matters', 'invoiceRemindersEnabled', "TEXT DEFAULT 'firm_default'");
  await ensureColumn('reminder_logs', 'invoiceId', 'TEXT');
  await ensureColumn('time_entries', 'taskId', 'TEXT');
  await ensureColumn('time_entries', 'billable', 'INTEGER DEFAULT 1');
  await run('UPDATE time_entries SET billable=1 WHERE billable IS NULL');
  await ensureColumn('users', 'isActive', 'INTEGER DEFAULT 1');
  await ensureColumn('users', 'avatar', 'BLOB');
  await ensureColumn('users', 'avatarMimeType', "TEXT DEFAULT ''");
  await ensureColumn('firm_settings', 'themeJson', 'TEXT');
  await ensureColumn('firm_settings', 'advocateBillingVisibility', 'INTEGER DEFAULT 1');
  await ensureColumn('firm_settings', 'paymentInstructions', "TEXT DEFAULT ''");
  await ensureColumn('firm_settings', 'kraPin', "TEXT DEFAULT ''");
  await ensureColumn('firm_settings', 'vatNumber', "TEXT DEFAULT ''");
  await ensureColumn('firm_settings', 'invoiceFooterNote', "TEXT DEFAULT ''");
  await ensureColumn('firm_settings', 'defaultInvoiceDueDays', 'INTEGER DEFAULT 30');
  await run('UPDATE firm_settings SET defaultInvoiceDueDays=30 WHERE defaultInvoiceDueDays NOT IN (7,14,30,45) OR defaultInvoiceDueDays IS NULL');
  await ensureColumn('payments', 'proofId', 'TEXT');
  await ensureColumn('payments', 'createdBy', 'TEXT');
  await ensureColumn('payments', 'createdAt', 'TEXT');
  await run("UPDATE payments SET createdAt=COALESCE(NULLIF(createdAt,''), COALESCE(NULLIF(date,''), CURRENT_TIMESTAMP)) WHERE createdAt IS NULL OR createdAt=''");
  await ensureColumn('payments', 'receiptNumber', 'TEXT');
  await ensureColumn('payments', 'receiptIssuedAt', 'TEXT');
  // PRODUCT-15O: non-destructive admin payment void. Existing rows stay active because voidedAt is NULL.
  await ensureColumn('payments', 'voidedAt', 'TEXT');
  await ensureColumn('payments', 'voidedBy', 'TEXT');
  await ensureColumn('payments', 'voidReason', 'TEXT');
  // PRODUCT-15I: payment-proof review lifecycle. Existing rows default to Pending.
  await ensureColumn('payment_proofs', 'status', "TEXT DEFAULT 'Pending'");
  await ensureColumn('payment_proofs', 'reviewedBy', 'TEXT');
  await ensureColumn('payment_proofs', 'reviewedAt', 'TEXT');
  await ensureColumn('payment_proofs', 'reviewNote', 'TEXT');
  await ensureColumn('payment_proofs', 'paymentId', 'TEXT');
  await run("UPDATE payment_proofs SET status='Pending' WHERE status IS NULL OR status=''");
  await ensureColumn('document_requests', 'description', 'TEXT');
  await ensureColumn('document_requests', 'respondedAt', 'TEXT');
  await ensureColumn('document_requests', 'responseDocumentId', 'TEXT');
  await ensureColumn('document_requests', 'cancelledAt', 'TEXT');
  await ensureColumn('document_requests', 'cancelledBy', 'TEXT');
  await run(`CREATE TABLE IF NOT EXISTS receipt_sequences (year TEXT PRIMARY KEY, lastSeq INTEGER NOT NULL DEFAULT 0)`);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receiptNumber ON payments(receiptNumber) WHERE receiptNumber IS NOT NULL AND receiptNumber<>""');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_events_action_timestamp ON audit_events(action, timestamp)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_events_actor_user_id_timestamp ON audit_events(actor_user_id, timestamp)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_events_matter_id_timestamp ON audit_events(matter_id, timestamp)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_events_client_id_timestamp ON audit_events(client_id, timestamp)');
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_completed_dueDate ON tasks(completed, dueDate)');
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_assignee_dueDate ON tasks(assignee, dueDate)');
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_matterId ON tasks(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_appearances_date ON appearances(date)');
  await run('CREATE INDEX IF NOT EXISTS idx_appearances_attorney_date ON appearances(attorney, date)');
  await run('CREATE INDEX IF NOT EXISTS idx_appearances_matterId ON appearances(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_matters_clientId ON matters(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_matters_assignedTo ON matters(assignedTo)');
  await run('CREATE INDEX IF NOT EXISTS idx_matters_solDate ON matters(solDate)');
  await run('CREATE INDEX IF NOT EXISTS idx_matters_stage ON matters(stage)');
  await run('CREATE INDEX IF NOT EXISTS idx_invoices_matterId ON invoices(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_invoices_dueDate_status ON invoices(dueDate, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_time_entries_matterId ON time_entries(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(date)');
  await run('CREATE INDEX IF NOT EXISTS idx_time_entries_attorney_date ON time_entries(attorney, date)');
  await run('CREATE INDEX IF NOT EXISTS idx_time_entries_billable_billed ON time_entries(billable, billed)');
  await run('CREATE INDEX IF NOT EXISTS idx_deadlines_dueDate_status_type ON deadlines(dueDate, status, type)');
  await run('CREATE INDEX IF NOT EXISTS idx_documents_matterId_deletedAt_date ON documents(matterId, deletedAt, date)');
  await run('CREATE INDEX IF NOT EXISTS idx_documents_folderId_deletedAt ON documents(folderId, deletedAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_documents_messageId_deletedAt ON documents(messageId, deletedAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_signature_assets_scope ON signature_assets(ownerType, ownerId, assetType, deletedAt, isDefault)');
  await run('CREATE INDEX IF NOT EXISTS idx_documents_noticeId_deletedAt ON documents(noticeId, deletedAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_messages_conversationId_createdAt ON messages(conversationId, createdAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_conversations_matterId ON conversations(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_conversations_clientId ON conversations(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_userId_readAt_createdAt ON notifications(userId, readAt, createdAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_email_messages_user_received ON work_email_messages(userId, receivedAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_email_messages_account_received ON work_email_messages(connectedAccountId, receivedAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_email_messages_matched_matter ON work_email_messages(matchedMatterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_connected_account_sync_state_account_type ON connected_account_sync_state(connectedAccountId, syncType)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_calendar_events_user_time ON work_calendar_events(userId, startTime)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_calendar_events_account_time ON work_calendar_events(connectedAccountId, startTime)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_calendar_events_matched_matter ON work_calendar_events(matchedMatterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_metadata_links_source_status ON work_metadata_matter_links(sourceType, sourceId, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_metadata_links_matter_status ON work_metadata_matter_links(matterId, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_work_metadata_links_confirmed_by ON work_metadata_matter_links(confirmedBy)');
  await run('CREATE INDEX IF NOT EXISTS idx_payments_invoiceId_date_createdAt ON payments(invoiceId, date, createdAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_payments_clientId_date_createdAt ON payments(clientId, date, createdAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_payment_proofs_status_createdAt ON payment_proofs(status, createdAt)');
  await run('CREATE INDEX IF NOT EXISTS idx_payment_proofs_matterId ON payment_proofs(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_document_requests_matterId ON document_requests(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_document_requests_clientId ON document_requests(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_document_requests_status ON document_requests(status)');
  await backfillSeededReceiptNumbers();
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
    
    const hashedPassword = await hashPassword(adminPassword);
    await run('INSERT INTO users (id,email,password,fullName,role,createdAt,tokenVersion) VALUES (?,?,?,?,?,?,?)', [genId('U'), adminEmail, hashedPassword, adminName, 'admin', new Date().toISOString(), 1]);
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

function actorLabel(req) {
  return req.user?.fullName || req.user?.email || req.user?.userId || '';
}

function normalizeChecklistOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTemplateActive(value) {
  if (value === undefined) return undefined;
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'active') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'inactive') return 0;
  return null;
}

function parseChecklistTemplateItems(items, required = false) {
  if (items === undefined) {
    return required ? { error: 'Template items are required' } : { items: null };
  }
  if (!Array.isArray(items)) return { error: 'Template items must be an array' };
  if (!items.length) return { error: 'At least one template item is required' };
  const parsed = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) return { error: 'Template item title is required' };
    if (title.length > 240) return { error: 'Template item title must not exceed 240 characters' };
    const position = item.position === undefined || item.position === '' ? index : Number(item.position);
    if (!Number.isFinite(position) || position < 0) return { error: 'Invalid template item position' };
    parsed.push({
      title,
      notes: typeof item.notes === 'string' ? item.notes : '',
      position,
    });
  }
  parsed.sort((a, b) => a.position - b.position);
  return { items: parsed };
}

async function attachChecklistTemplateItems(templates) {
  const rows = Array.isArray(templates) ? templates : [];
  for (const template of rows) {
    template.items = await all('SELECT * FROM checklist_template_items WHERE templateId=? ORDER BY position ASC, createdAt ASC, id ASC', [template.id]);
  }
  return rows;
}

async function getChecklistTemplateWithItems(templateId, activeOnly = false) {
  const template = activeOnly
    ? await get('SELECT * FROM checklist_templates WHERE id=? AND active=1', [templateId])
    : await get('SELECT * FROM checklist_templates WHERE id=?', [templateId]);
  if (!template) return null;
  const [withItems] = await attachChecklistTemplateItems([template]);
  return withItems;
}

function documentAuditContext(doc = {}) {
  if (doc.messageId) return 'communication_attachment';
  if (doc.noticeId) return 'notice_attachment';
  if (doc.source === 'client') return 'client_uploaded_document';
  if (Number(doc.clientVisible || 0) === 1) return 'client_visible_document';
  return 'matter_document';
}

async function documentAuditClientId(doc = {}, req = null) {
  if (req?.user?.role === 'client' && req.user.clientId) return req.user.clientId;
  if (doc.matterId) {
    const matter = await get('SELECT clientId FROM matters WHERE id=?', [doc.matterId]);
    if (matter?.clientId) return matter.clientId;
  }
  if (doc.noticeId) {
    const notice = await get('SELECT clientId FROM firm_notices WHERE id=?', [doc.noticeId]);
    if (notice?.clientId) return notice.clientId;
  }
  if (doc.messageId) {
    const conversation = await get(`SELECT conv.clientId
      FROM messages msg
      JOIN conversations conv ON conv.id=msg.conversationId
      WHERE msg.id=?`, [doc.messageId]);
    if (conversation?.clientId) return conversation.clientId;
  }
  return '';
}

function safeDocumentMetadata(doc = {}, context, route, extra = {}) {
  return {
    documentId: doc.id || '',
    filename: cleanDocumentName(doc.displayName || doc.name || doc.id || ''),
    mimeType: doc.mimeType || '',
    source: doc.source || '',
    context,
    route,
    ...extra,
  };
}

function cleanPdfDownloadName(filename = '') {
  const requested = cleanDocumentName(String(filename || '').trim() || 'merged-document.pdf');
  return /\.pdf$/i.test(requested) ? requested : `${requested}.pdf`;
}

// Parse a one-based page-range string (e.g. "1-3,5,7-9") into zero-based page
// indexes, preserving the explicit order entered. Returns { indices } on success
// or { error } with a safe message. Pure: no I/O, no thrown stack traces.
function parsePageRanges(input, pageCount) {
  if (typeof input !== 'string') return { error: 'Enter page ranges such as 1-3,5,7' };
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Enter page ranges such as 1-3,5,7' };
  if (!Number.isInteger(pageCount) || pageCount < 1) return { error: 'The PDF has no pages to extract' };

  const pages = [];
  for (const rawToken of trimmed.split(',')) {
    const token = rawToken.trim();
    if (!token) return { error: 'Page ranges contain an empty value' };
    if (token.includes('-')) {
      const parts = token.split('-').map(part => part.trim());
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        return { error: `"${token}" is not a valid page range` };
      }
      const start = Number(parts[0]);
      const end = Number(parts[1]);
      if (start < 1 || end < 1) return { error: 'Page numbers must be 1 or greater' };
      if (end < start) return { error: `"${token}" is a reversed range` };
      if (end > pageCount) return { error: `Page ${end} is out of range — the PDF has ${pageCount} page(s)` };
      for (let page = start; page <= end; page++) pages.push(page);
    } else {
      if (!/^\d+$/.test(token)) return { error: `"${token}" is not a valid page number` };
      const page = Number(token);
      if (page < 1) return { error: 'Page numbers must be 1 or greater' };
      if (page > pageCount) return { error: `Page ${page} is out of range — the PDF has ${pageCount} page(s)` };
      pages.push(page);
    }
  }

  if (!pages.length) return { error: 'Enter page ranges such as 1-3,5,7' };
  if (pages.length > MAX_EXTRACT_PDF_PAGES) return { error: `Select no more than ${MAX_EXTRACT_PDF_PAGES} pages` };

  const seen = new Set();
  for (const page of pages) {
    if (seen.has(page)) return { error: `Page ${page} is selected more than once` };
    seen.add(page);
  }

  return { indices: pages.map(page => page - 1) };
}

// PRODUCT-27D: parse a user-entered page sequence for the split / reorder tool.
// Unlike parsePageRanges, this PRESERVES the exact order entered and ALLOWS
// repeats, so a user can intentionally duplicate a page. Supports comma-separated
// page numbers and simple ascending ranges, e.g. "3,1,2" or "1-3,5".
function parsePageOrder(input, pageCount) {
  if (typeof input !== 'string') return { error: 'Enter a page order such as 3,1,2 or 1-3,5' };
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Enter a page order such as 3,1,2 or 1-3,5' };
  if (!Number.isInteger(pageCount) || pageCount < 1) return { error: 'The PDF has no pages to reorder' };

  const pages = [];
  for (const rawToken of trimmed.split(',')) {
    const token = rawToken.trim();
    if (!token) return { error: 'Page order contains an empty value' };
    if (token.includes('-')) {
      const parts = token.split('-').map(part => part.trim());
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        return { error: `"${token}" is not a valid page range` };
      }
      const start = Number(parts[0]);
      const end = Number(parts[1]);
      if (start < 1 || end < 1) return { error: 'Page numbers must be 1 or greater' };
      if (end < start) return { error: `"${token}" is a reversed range` };
      if (end > pageCount) return { error: `Page ${end} is out of range — the PDF has ${pageCount} page(s)` };
      for (let page = start; page <= end; page++) pages.push(page);
    } else {
      if (!/^\d+$/.test(token)) return { error: `"${token}" is not a valid page number` };
      const page = Number(token);
      if (page < 1) return { error: 'Page numbers must be 1 or greater' };
      if (page > pageCount) return { error: `Page ${page} is out of range — the PDF has ${pageCount} page(s)` };
      pages.push(page);
    }
  }

  if (!pages.length) return { error: 'Enter a page order such as 3,1,2 or 1-3,5' };
  // Repeats are allowed, so cap on the resulting (output) page count.
  if (pages.length > MAX_EXTRACT_PDF_PAGES) return { error: `Select no more than ${MAX_EXTRACT_PDF_PAGES} pages` };

  return { pages, indices: pages.map(page => page - 1) };
}

async function matterFolders(matterId, req = null) {
  if (req?.user?.role === 'client') {
    const visibleCount = await get(`SELECT COUNT(*) documentCount FROM documents d WHERE d.matterId=? AND d.deletedAt IS NULL AND ${clientDocumentVisibilitySql('d')}`, [matterId, req.user.clientId || '']);
    const clientFolder = await get(`SELECT f.*, (SELECT COUNT(*) FROM documents d WHERE d.folderId=f.id AND d.deletedAt IS NULL AND ${clientDocumentVisibilitySql('d')}) documentCount
      FROM folders f
      WHERE f.matterId=? AND lower(f.name)=lower('Client Uploads')`, [req.user.clientId || '', matterId]);
    const folders = clientFolder ? [{ ...clientFolder, name: 'Client Uploads' }] : [];
    return [{ id: 'all', matterId, name: 'All Documents', virtual: true, documentCount: visibleCount?.documentCount || 0 }, ...folders];
  }
  const folders = await all(`SELECT f.*, (SELECT COUNT(*) FROM documents d WHERE d.folderId=f.id AND d.deletedAt IS NULL) documentCount FROM folders f WHERE f.matterId=? ORDER BY CASE WHEN lower(f.name)=lower('Client Uploads') THEN 0 ELSE 1 END, lower(f.name)`, [matterId]);
  const uncategorised = await get('SELECT COUNT(*) documentCount FROM documents WHERE matterId=? AND deletedAt IS NULL AND (folderId IS NULL OR folderId="")', [matterId]);
  return [{ id: 'all', matterId, name: 'All Documents', virtual: true }, { id: 'uncategorised', matterId, name: 'Uncategorised', virtual: true, documentCount: uncategorised.documentCount || 0 }, ...folders];
}

app.post('/api/auth/login', authLimiter, validate(loginValidation), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE lower(email)=lower(?)', [email || '']);
    if (!user || !(await verifyPassword(password || '', user.password || ''))) {
      // Log failed login attempt
      await recordAuditEvent(req, { action: 'login_failure', entityType: 'user', metadata: { email, reason: 'invalid credentials' } }).catch(() => {});
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.isActive === 0) {
      await recordAuditEvent(req, { action: 'login_failure', entityType: 'user', entityId: user.id, metadata: { email: user.email, role: user.role, reason: 'account inactive' } }).catch(() => {});
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.role === 'client') return res.status(403).json({ error: 'Please use the Client Portal login.' });
    const token = signAccessToken(user);
    // Log successful login
    await recordAuditEvent(req, { action: 'login_success', entityType: 'user', entityId: user.id, metadata: { email: user.email, role: user.role } }).catch(() => {});
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, name: user.fullName, role: user.role, clientId: user.clientId || '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/client-login', authLimiter, validate(loginValidation), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE lower(email)=lower(?) AND role=?', [email || '', 'client']);
    if (!user) {
      await recordAuditEvent(req, { action: 'client_login_failure', entityType: 'user', metadata: { email, reason: 'unknown_client', loginMethod: 'client_portal' } }).catch(() => {});
      return res.status(401).json({ error: 'Invalid client email or password' });
    }
    if (!(await verifyPassword(password || '', user.password || ''))) {
      await recordAuditEvent(req, { action: 'client_login_failure', entityType: 'user', entityId: user.id, clientId: user.clientId || '', metadata: { email: user.email, role: user.role, reason: 'invalid_credentials', loginMethod: 'client_portal' } }).catch(() => {});
      return res.status(401).json({ error: 'Invalid client email or password' });
    }
    if (user.isActive === 0) {
      await recordAuditEvent(req, { action: 'login_failure', entityType: 'user', entityId: user.id, metadata: { email: user.email, role: user.role, reason: 'account inactive' } }).catch(() => {});
      await recordAuditEvent(req, { action: 'client_login_failure', entityType: 'user', entityId: user.id, clientId: user.clientId || '', metadata: { email: user.email, role: user.role, reason: 'inactive_account', loginMethod: 'client_portal' } }).catch(() => {});
      return res.status(401).json({ error: 'Invalid client email or password' });
    }
    const token = signAccessToken(user);
    await recordAuditEvent(req, { action: 'client_login_success', entityType: 'user', entityId: user.id, clientId: user.clientId || '', metadata: { email: user.email, role: user.role, loginMethod: 'client_portal' } }).catch(() => {});
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
  const attachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.noticeId IN (${placeholders}) AND d.deletedAt IS NULL${attachmentVisibility} ORDER BY d.date DESC, d.displayName, d.name`, ids);
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
  if (!password) return res.status(400).json({ error: 'Password is required' });
  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) return res.status(400).json({ error: 'Password does not meet security requirements', details: passwordPolicy.errors });
  const existing = await get('SELECT id FROM users WHERE lower(email)=lower(?)', [invitation.email]);
  if (existing) return res.status(400).json({ error: 'A user with this email already exists' });
  const id = genId('U');
  const name = fullName || invitation.email.split('@')[0];
  const createdAt = new Date().toISOString();
  await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt) VALUES (?,?,?,?,?,?,?)', [id, invitation.email, await hashPassword(password), name, 'client', invitation.clientId || '', createdAt]);
  await run("UPDATE invitations SET status='used' WHERE token=?", [req.params.token]);
  const token = signAccessToken({ id, role: 'client', fullName: name, clientId: invitation.clientId || '', email: invitation.email, tokenVersion: 1 });
  res.json({ message: 'Client portal account created.', token, user: { id, email: invitation.email, fullName: name, name, role: 'client', clientId: invitation.clientId || '' } });
});
// Trim and length-cap a firm billing/tax display field so user input cannot
// bloat invoice/receipt PDFs or the firm_settings row. Returns '' for blanks.
function normalizeFirmBillingField(value, maxLength) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength);
}

const ALLOWED_INVOICE_DUE_DAYS = new Set([7, 14, 30, 45]);

function normalizeDefaultInvoiceDueDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && ALLOWED_INVOICE_DUE_DAYS.has(days) ? days : 30;
}

function validIsoDateOnly(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return text;
}

// Normalized firm tax / payment-instruction / footer-note fields used by the
// invoice and receipt PDFs (PRODUCT-15B).
function firmBillingFields(firm) {
  return {
    kraPin: normalizeFirmBillingField(firm?.kraPin, 80),
    vatNumber: normalizeFirmBillingField(firm?.vatNumber, 80),
    paymentInstructions: normalizeFirmBillingField(firm?.paymentInstructions, 800),
    invoiceFooterNote: normalizeFirmBillingField(firm?.invoiceFooterNote, 500),
  };
}

// Draw the optional firm tax / payment-instruction / footer-note block used by
// invoice and receipt PDFs. Returns the y after the block. Renders nothing (and
// returns the incoming y) when every field is blank, so blank-firm layouts stay
// unchanged. Breaks to a new page if the block would collide with the footer.
function drawFirmBillingBlock(doc, firm, x, startY, width) {
  const { kraPin, vatNumber, paymentInstructions, invoiceFooterNote } = firmBillingFields(firm);
  if (!kraPin && !vatNumber && !paymentInstructions && !invoiceFooterNote) return startY;
  let estimate = 0;
  if (kraPin || vatNumber) estimate += 14 + (kraPin ? 13 : 0) + (vatNumber ? 13 : 0) + 6;
  if (paymentInstructions) { doc.font('Helvetica').fontSize(9); estimate += 14 + doc.heightOfString(paymentInstructions, { width }) + 6; }
  if (invoiceFooterNote) { doc.font('Helvetica').fontSize(8); estimate += doc.heightOfString(invoiceFooterNote, { width }) + 4; }
  let y = startY;
  if (y + estimate > 745) { doc.addPage(); y = 60; }
  if (kraPin || vatNumber) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151').text('Tax Details', x, y); y += 14;
    doc.font('Helvetica').fontSize(9).fillColor('#111827');
    if (kraPin) { doc.text(`KRA PIN: ${kraPin}`, x, y, { width }); y += 13; }
    if (vatNumber) { doc.text(`VAT No: ${vatNumber}`, x, y, { width }); y += 13; }
    y += 6;
  }
  if (paymentInstructions) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151').text('Payment Instructions', x, y); y += 14;
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(paymentInstructions, x, y, { width });
    y = doc.y + 6;
  }
  if (invoiceFooterNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#6B7280').text(invoiceFooterNote, x, y, { width });
    y = doc.y + 4;
  }
  return y;
}

app.put('/api/firm-settings', authenticate, requireAdmin, async (req, res) => {
  const existing = await get('SELECT * FROM firm_settings WHERE id=?', ['default']);
  const oldBillingVisibility = existing ? Number(existing.advocateBillingVisibility) : 1;
  const settings = { ...defaultFirmSettings, ...req.body, id: 'default' };
  settings.paymentInstructions = normalizeFirmBillingField(settings.paymentInstructions, 800);
  settings.kraPin = normalizeFirmBillingField(settings.kraPin, 80);
  settings.vatNumber = normalizeFirmBillingField(settings.vatNumber, 80);
  settings.invoiceFooterNote = normalizeFirmBillingField(settings.invoiceFooterNote, 500);
  settings.defaultInvoiceDueDays = normalizeDefaultInvoiceDueDays(settings.defaultInvoiceDueDays);
  await run(`INSERT INTO firm_settings (id,name,logo,primaryColor,accentColor,websiteURL,email,phone,address,paymentInstructions,kraPin,vatNumber,invoiceFooterNote,defaultInvoiceDueDays)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, logo=excluded.logo, primaryColor=excluded.primaryColor, accentColor=excluded.accentColor, websiteURL=excluded.websiteURL, email=excluded.email, phone=excluded.phone, address=excluded.address, paymentInstructions=excluded.paymentInstructions, kraPin=excluded.kraPin, vatNumber=excluded.vatNumber, invoiceFooterNote=excluded.invoiceFooterNote, defaultInvoiceDueDays=excluded.defaultInvoiceDueDays`,
    [settings.id, settings.name, settings.logo, settings.primaryColor, settings.accentColor, settings.websiteURL, settings.email, settings.phone, settings.address, settings.paymentInstructions, settings.kraPin, settings.vatNumber, settings.invoiceFooterNote, settings.defaultInvoiceDueDays]);
  if (req.body.reminderSettings) {
    await saveReminderSettings(req.body.reminderSettings);
    await logAudit(req, 'update', 'reminder_settings', 'default', 'Updated reminder channel settings');
  }
  if (req.body.advocateBillingVisibility !== undefined) {
    await run('UPDATE firm_settings SET advocateBillingVisibility=?', [Number(req.body.advocateBillingVisibility)]);
  }
  const fieldsUpdated = Object.keys(req.body).filter(k => k !== 'reminderSettings');
  const metadata = { name: settings.name, fieldsUpdated };
  if (req.body.advocateBillingVisibility !== undefined && req.body.advocateBillingVisibility !== oldBillingVisibility) {
    metadata.advocateBillingVisibility = { old: oldBillingVisibility, new: Number(req.body.advocateBillingVisibility) };
  }
  await logAudit(req, 'update', 'firm_settings', 'default', `Updated firm settings for ${settings.name}`);
  await recordAuditEvent(req, { action: 'firm_settings_updated', entityType: 'firm_settings', entityId: 'default', metadata }).catch(() => {});
  res.json(await getFirmSettings());
});

app.get('/api/firm-settings/theme', authenticate, async (req, res) => {
  try {
    const settings = await get('SELECT themeJson FROM firm_settings WHERE id=?', ['default']);
    let theme = null;
    if (settings && settings.themeJson) {
      try { theme = JSON.parse(settings.themeJson); } catch { theme = null; }
    }
    res.json({ theme });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/firm-settings/theme/preview', authenticate, requireAdmin, async (req, res) => {
  try {
    const validation = themeValidation.validateThemeInput(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { warnings, blocks } = themeValidation.validateThemeAccessibility(validation.value);
    if (blocks.length > 0) return res.status(400).json({ error: 'Theme blocked', details: blocks });
    res.json({ theme: validation.value, warnings, blocks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/firm-settings/theme', authenticate, requireAdmin, async (req, res) => {
  try {
    const validation = themeValidation.validateThemeInput(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { warnings, blocks } = themeValidation.validateThemeAccessibility(validation.value);
    if (blocks.length > 0) return res.status(400).json({ error: 'Theme blocked', details: blocks });
    const themeJson = JSON.stringify(validation.value);
    const existing = await get('SELECT id FROM firm_settings WHERE id=?', ['default']);
    if (existing) {
      await run('UPDATE firm_settings SET themeJson=? WHERE id=?', [themeJson, 'default']);
    } else {
      await run(`INSERT INTO firm_settings (id,name,logo,primaryColor,accentColor,websiteURL,email,phone,address,themeJson)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ['default', defaultFirmSettings.name, '', defaultFirmSettings.primaryColor, defaultFirmSettings.accentColor, '', defaultFirmSettings.email, defaultFirmSettings.phone, defaultFirmSettings.address, themeJson]);
    }
    await logAudit(req, 'update', 'firm_theme', 'default', 'Updated firm theme');
    await recordAuditEvent(req, { action: 'firm_theme_updated', entityType: 'firm_theme', entityId: 'default', metadata: { source: validation.value.source || 'manual', warnings } }).catch(() => {});
    const settings = await get('SELECT themeJson FROM firm_settings WHERE id=?', ['default']);
    res.json({ theme: JSON.parse(settings.themeJson), warnings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/firm-settings/theme/reset', authenticate, requireAdmin, async (req, res) => {
  try {
    const existing = await get('SELECT id FROM firm_settings WHERE id=?', ['default']);
    if (existing) {
      await run('UPDATE firm_settings SET themeJson=NULL WHERE id=?', ['default']);
    }
    await logAudit(req, 'update', 'firm_theme', 'default', 'Reset firm theme to default');
    await recordAuditEvent(req, { action: 'firm_theme_reset', entityType: 'firm_theme', entityId: 'default' }).catch(() => {});
    res.json({ theme: null, message: 'Theme reset to default' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/firm-settings/theme/presets', authenticate, async (req, res) => {
  try {
    res.json({ presets: themeValidation.getPresets() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// In-memory one-time exchange code store for OAuth callback flow.
// Codes are 32 random bytes (64 hex chars), single-use, TTL 60 seconds.
// Never persisted to database — survives only in process memory.
const oauthExchangeCodes = new Map();
const OAUTH_CODE_TTL_MS = 60000;

function createOAuthExchangeCode(result) {
  pruneExpiredCodes();
  const code = crypto.randomBytes(32).toString('hex');
  oauthExchangeCodes.set(code, { token: result.token, user: result.user, expiresAt: Date.now() + OAUTH_CODE_TTL_MS });
  return code;
}

function consumeOAuthExchangeCode(code) {
  pruneExpiredCodes();
  if (!code || typeof code !== 'string') return null;
  const entry = oauthExchangeCodes.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { oauthExchangeCodes.delete(code); return null; }
  oauthExchangeCodes.delete(code);
  return { token: entry.token, user: entry.user };
}

function pruneExpiredCodes() {
  const now = Date.now();
  for (const [code, entry] of oauthExchangeCodes) {
    if (now > entry.expiresAt) oauthExchangeCodes.delete(code);
  }
}

// --- Staff OAuth routes (no authentication required) ---
app.get('/api/auth/oauth/google/start', async (req, res) => {
  if (!config.OAUTH_STAFF_ENABLED) return res.status(503).json({ error: 'Staff OAuth is not enabled.' });
  try {
    const state = signState('google');
    const url = googleOAuth.buildAuthorizationUrl(state);
    await recordAuditEvent(req, { action: 'oauth_login_started', entityType: 'oauth', metadata: { provider: 'google' } }).catch(() => {});
    res.json({ authorizationUrl: url });
  } catch (err) { res.status(500).json({ error: 'OAuth is not configured.' }); }
});

app.get('/api/auth/oauth/google/callback', async (req, res) => {
  if (!config.OAUTH_STAFF_ENABLED) return res.status(400).json({ error: 'Staff OAuth is not enabled.' });
  const { code, state, error: providerError } = req.query;
  if (providerError) {
    await recordAuditEvent(req, { action: 'oauth_login_failed', entityType: 'oauth', metadata: { provider: 'google', reason: providerError } }).catch(() => {});
    return res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent('Provider denied access')}`);
  }
  const stateCheck = verifyState(state, 'google');
  if (!stateCheck.valid) {
    await recordAuditEvent(req, { action: 'oauth_login_failed', entityType: 'oauth', metadata: { provider: 'google', reason: 'invalid_state' } }).catch(() => {});
    return res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent('Invalid session. Try again.')}`);
  }
  try {
    const profile = await googleOAuth.handleCallback(code);
    const result = await oauth.completeOAuthLogin(profile);
    if (!result.ok) {
      await recordAuditEvent(req, { action: result.error === 'unknown_user' ? 'oauth_unknown_user_rejected' : result.error === 'client_rejected' ? 'oauth_login_failed' : 'oauth_login_failed', entityType: result.user?.id ? 'user' : 'oauth', entityId: result.user?.id, metadata: { provider: 'google', reason: result.error, role: result.user?.role || '' } }).catch(() => {});
      return res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent(result.message)}`);
    }
    await recordAuditEvent(req, { action: 'oauth_login_succeeded', entityType: 'user', entityId: result.user.id, metadata: { provider: 'google', role: result.user.role } }).catch(() => {});
    const exchangeCode = createOAuthExchangeCode(result);
    res.redirect(`${config.BASE_URL}/oauth/callback?code=${exchangeCode}`);
  } catch (err) {
    await recordAuditEvent(req, { action: 'oauth_login_failed', entityType: 'oauth', metadata: { provider: 'google', reason: 'exchange_error' } }).catch(() => {});
    res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent('OAuth login failed.')}`);
  }
});

app.get('/api/auth/oauth/microsoft/start', async (req, res) => {
  if (!config.OAUTH_STAFF_ENABLED) return res.status(503).json({ error: 'Staff OAuth is not enabled.' });
  try {
    const state = signState('microsoft');
    const url = microsoftOAuth.buildAuthorizationUrl(state);
    await recordAuditEvent(req, { action: 'oauth_login_started', entityType: 'oauth', metadata: { provider: 'microsoft' } }).catch(() => {});
    res.json({ authorizationUrl: url });
  } catch (err) { res.status(500).json({ error: 'OAuth is not configured.' }); }
});

app.get('/api/auth/oauth/microsoft/callback', async (req, res) => {
  if (!config.OAUTH_STAFF_ENABLED) return res.status(400).json({ error: 'Staff OAuth is not enabled.' });
  const { code, state, error: providerError } = req.query;
  if (providerError) {
    await recordAuditEvent(req, { action: 'oauth_login_failed', entityType: 'oauth', metadata: { provider: 'microsoft', reason: providerError } }).catch(() => {});
    return res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent('Provider denied access')}`);
  }
  const stateCheck = verifyState(state, 'microsoft');
  if (!stateCheck.valid) {
    await recordAuditEvent(req, { action: 'oauth_login_failed', entityType: 'oauth', metadata: { provider: 'microsoft', reason: 'invalid_state' } }).catch(() => {});
    return res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent('Invalid session. Try again.')}`);
  }
  try {
    const profile = await microsoftOAuth.handleCallback(code);
    const result = await oauth.completeOAuthLogin(profile);
    if (!result.ok) {
      await recordAuditEvent(req, { action: result.error === 'unknown_user' ? 'oauth_unknown_user_rejected' : result.error === 'client_rejected' ? 'oauth_login_failed' : 'oauth_login_failed', entityType: result.user?.id ? 'user' : 'oauth', entityId: result.user?.id, metadata: { provider: 'microsoft', reason: result.error, role: result.user?.role || '' } }).catch(() => {});
      return res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent(result.message)}`);
    }
    await recordAuditEvent(req, { action: 'oauth_login_succeeded', entityType: 'user', entityId: result.user.id, metadata: { provider: 'microsoft', role: result.user.role } }).catch(() => {});
    const exchangeCode = createOAuthExchangeCode(result);
    res.redirect(`${config.BASE_URL}/oauth/callback?code=${exchangeCode}`);
  } catch (err) {
    await recordAuditEvent(req, { action: 'oauth_login_failed', entityType: 'oauth', metadata: { provider: 'microsoft', reason: 'exchange_error' } }).catch(() => {});
    res.redirect(`${config.BASE_URL}/oauth/callback?error=${encodeURIComponent('OAuth login failed.')}`);
  }
});

app.post('/api/auth/oauth/exchange', async (req, res) => {
  const { code } = req.body || {};
  const result = consumeOAuthExchangeCode(code);
  if (!result) {
    return res.status(400).json({ error: 'Invalid or expired exchange code. Please re-authenticate.' });
  }
  res.json({ token: result.token, user: result.user });
});

const CONNECTED_ACCOUNT_PROVIDERS = new Set(['google', 'microsoft']);

function connectedAccountProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return CONNECTED_ACCOUNT_PROVIDERS.has(normalized) ? normalized : '';
}

function connectedAccountAuthorizationUrl(provider, state) {
  if (provider === 'google') return googleOAuth.buildConnectedAuthorizationUrl(state);
  if (provider === 'microsoft') return microsoftOAuth.buildConnectedAuthorizationUrl(state);
  throw new Error('Unsupported connected account provider');
}

function connectedAccountCallbackUrl(provider, status, reason = '') {
  const params = new URLSearchParams({ connected_account: status, provider: provider || '' });
  if (reason) params.set('reason', reason);
  return `${config.BASE_URL}/?${params.toString()}`;
}

function attachConnectedAccountAuditUser(req, user) {
  req.user = {
    userId: user.id,
    role: user.role,
    email: user.email || '',
    fullName: user.fullName || '',
    clientId: user.clientId || '',
  };
  return req;
}

async function connectedAccountStateUser(req, provider, state) {
  const stateCheck = verifyState(state, provider);
  if (!stateCheck.valid) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: 'invalid_state' } }).catch(() => {});
    return { ok: false, error: 'invalid_state' };
  }
  const context = stateCheck.context || {};
  if (context.purpose !== 'connected_account' || !context.userId) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: 'invalid_state_context' } }).catch(() => {});
    return { ok: false, error: 'invalid_state_context' };
  }
  const user = await get('SELECT id, email, fullName, role, clientId, COALESCE(isActive,1) isActive FROM users WHERE id=?', [context.userId]);
  if (!user || user.isActive === 0 || user.role === 'client') {
    if (user) attachConnectedAccountAuditUser(req, user);
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: 'user_not_allowed' } }).catch(() => {});
    return { ok: false, error: 'user_not_allowed' };
  }
  attachConnectedAccountAuditUser(req, user);
  return { ok: true, user };
}

function workEmailProviderClient(provider) {
  if (provider === 'google') return googleOAuth;
  if (provider === 'microsoft') return microsoftOAuth;
  throw new Error('Unsupported work email provider');
}

function workCalendarProviderClient(provider) {
  if (provider === 'google') return googleOAuth;
  if (provider === 'microsoft') return microsoftOAuth;
  throw new Error('Unsupported work calendar provider');
}

function parseWorkEmailCursor(cursorJson) {
  if (!cursorJson) return {};
  try {
    const parsed = JSON.parse(cursorJson);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function cleanWorkEmailText(value, maxLength = 1000) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLength) : '';
}

function jsonArrayText(value) {
  const values = Array.isArray(value) ? value : [];
  return JSON.stringify(values.map(item => cleanWorkEmailText(String(item || ''), 200)).filter(Boolean));
}

function normalizeReceivedAt(value) {
  const text = cleanWorkEmailText(value, 120);
  if (!text) return '';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function normalizeWorkEmailMessage(message = {}) {
  return {
    providerMessageId: cleanWorkEmailText(message.providerMessageId, 500),
    providerThreadId: cleanWorkEmailText(message.providerThreadId, 500),
    sender: cleanWorkEmailText(message.sender, 500),
    recipientsSummary: cleanWorkEmailText(message.recipientsSummary, 1000),
    subject: cleanWorkEmailText(message.subject, 500),
    snippet: cleanWorkEmailText(message.snippet, 1000),
    receivedAt: normalizeReceivedAt(message.receivedAt),
    hasAttachments: message.hasAttachments ? 1 : 0,
    labelsJson: jsonArrayText(message.labels),
    foldersJson: jsonArrayText(message.folders),
  };
}

function wordsForMatch(value, minLength = 3) {
  return cleanWorkEmailText(value, 500)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(word => word.length >= minLength);
}

function emailDomain(email) {
  const match = String(email || '').toLowerCase().match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
  return match ? match[1] : '';
}

function bestMatterCandidate(current, candidate) {
  if (!candidate) return current;
  if (!current || Number(candidate.confidence || 0) > Number(current.confidence || 0)) return candidate;
  return current;
}

function confirmationSourceFor(row = {}) {
  if (!row.confirmedMatterId) return '';
  return row.confirmedMatterId === row.matchedMatterId ? 'suggested' : 'manual_override';
}

function activeMetadataLinkJoin(sourceType, sourceAlias = '') {
  return `LEFT JOIN work_metadata_matter_links wml ON wml.id=(
      SELECT id FROM work_metadata_matter_links active_wml
      WHERE active_wml.sourceType='${sourceType}' AND active_wml.sourceId=${sourceAlias}.id AND active_wml.status='confirmed'
      ORDER BY active_wml.confirmedAt DESC, active_wml.createdAt DESC
      LIMIT 1
    )
    LEFT JOIN matters cm ON cm.id=wml.matterId
    LEFT JOIN clients cc ON cc.id=cm.clientId`;
}

async function suggestMatterForWorkEmail(req, message) {
  const params = [];
  let where = '';
  if (req.user.role === 'advocate') {
    where = 'WHERE m.assignedTo=?';
    params.push(req.user.fullName || '');
  }
  const matters = await all(
    `SELECT m.id, m.reference, m.caseNo, m.title, c.name clientName, c.email clientEmail
     FROM matters m
     LEFT JOIN clients c ON c.id=m.clientId
     ${where}`,
    params,
  );
  const haystack = [
    message.subject,
    message.snippet,
    message.sender,
    message.recipientsSummary,
  ].map(value => cleanWorkEmailText(value, 1000).toLowerCase()).join(' ');
  const addressText = [message.sender, message.recipientsSummary].join(' ').toLowerCase();
  let best = null;
  for (const matter of matters) {
    const reference = cleanWorkEmailText(matter.reference, 120).toLowerCase();
    const caseNo = cleanWorkEmailText(matter.caseNo, 120).toLowerCase();
    if (reference && haystack.includes(reference)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.95, reason: `Reference match: ${matter.reference}` });
      continue;
    }
    if (caseNo && haystack.includes(caseNo)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.92, reason: `Case number match: ${matter.caseNo}` });
      continue;
    }

    const clientEmail = cleanWorkEmailText(matter.clientEmail, 255).toLowerCase();
    if (clientEmail && addressText.includes(clientEmail)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.88, reason: `Client email match: ${matter.clientEmail}` });
      continue;
    }
    const clientDomain = emailDomain(clientEmail);
    if (clientDomain && !GENERIC_EMAIL_DOMAINS.has(clientDomain) && addressText.includes(clientDomain)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.72, reason: `Client email domain match: ${clientDomain}` });
    }

    const clientWords = wordsForMatch(matter.clientName, 3);
    if (clientWords.length && clientWords.every(word => haystack.includes(word))) {
      best = bestMatterCandidate(best, { matter, confidence: 0.74, reason: `Client name match: ${matter.clientName}` });
    }

    const titleWords = wordsForMatch(matter.title, 4).slice(0, 5);
    const titleHits = titleWords.filter(word => haystack.includes(word)).length;
    if (titleWords.length >= 2 && titleHits >= Math.min(2, titleWords.length)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.66, reason: `Matter title terms match: ${matter.title}` });
    }
  }
  if (!best || Number(best.confidence || 0) < 0.6) return null;
  return {
    matterId: best.matter.id,
    matterTitle: best.matter.title || '',
    clientName: best.matter.clientName || '',
    confidence: Number(best.confidence.toFixed(2)),
    reason: best.reason,
  };
}

function publicWorkEmailMessage(row = {}) {
  return {
    id: row.id,
    connectedAccountId: row.connectedAccountId,
    provider: row.provider,
    providerAccountId: row.providerAccountId || '',
    providerMessageId: row.providerMessageId || '',
    providerThreadId: row.providerThreadId || '',
    sender: row.sender || '',
    recipientsSummary: row.recipientsSummary || '',
    subject: row.subject || '',
    snippet: row.snippet || '',
    receivedAt: row.receivedAt || '',
    hasAttachments: Boolean(row.hasAttachments),
    labels: safeJsonArray(row.labelsJson),
    folders: safeJsonArray(row.foldersJson),
    matchedMatterId: row.matchedMatterId || '',
    matchedMatterTitle: row.matchedMatterTitle || '',
    matchedClientName: row.matchedClientName || '',
    matchConfidence: row.matchConfidence === null || row.matchConfidence === undefined ? null : Number(row.matchConfidence),
    matchReason: row.matchReason || '',
    confirmedMatterId: row.confirmedMatterId || '',
    confirmedMatterTitle: row.confirmedMatterTitle || '',
    confirmedClientName: row.confirmedClientName || '',
    confirmedAt: row.confirmedAt || '',
    confirmedBy: row.confirmedBy || '',
    confirmationStatus: row.confirmedMatterId ? (row.confirmationStatus || 'confirmed') : '',
    confirmationSource: confirmationSourceFor(row),
    importedAt: row.importedAt || '',
    updatedAt: row.updatedAt || '',
    accountEmail: row.accountEmail || '',
    accountProvider: row.accountProvider || row.provider || '',
  };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function upsertWorkEmailSyncState(connectedAccountId, { cursor = '', lastAttemptAt, lastSuccessAt = '', lastError = '', lastImportedCount = 0 }) {
  const now = new Date().toISOString();
  const existing = await get('SELECT id FROM connected_account_sync_state WHERE connectedAccountId=? AND syncType=?', [connectedAccountId, WORK_EMAIL_SYNC_TYPE]);
  const cursorJson = JSON.stringify({ cursor: cleanWorkEmailText(cursor, 4000) });
  if (existing) {
    await run(
      `UPDATE connected_account_sync_state
       SET cursorJson=?, lastAttemptAt=?, lastSuccessAt=?, lastError=?, lastImportedCount=?, updatedAt=?
       WHERE id=?`,
      [cursorJson, lastAttemptAt || now, lastSuccessAt, lastError, Number(lastImportedCount || 0), now, existing.id],
    );
    return existing.id;
  }
  const id = genId('CAS');
  await run(
    `INSERT INTO connected_account_sync_state
     (id,connectedAccountId,syncType,cursorJson,lastAttemptAt,lastSuccessAt,lastError,lastImportedCount,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, connectedAccountId, WORK_EMAIL_SYNC_TYPE, cursorJson, lastAttemptAt || now, lastSuccessAt, lastError, Number(lastImportedCount || 0), now, now],
  );
  return id;
}

async function storeWorkEmailMetadata(req, account, providerResult, attemptAt) {
  const messages = (Array.isArray(providerResult?.messages) ? providerResult.messages : [])
    .map(normalizeWorkEmailMessage)
    .filter(message => message.providerMessageId);
  const now = new Date().toISOString();
  let importedCount = 0;
  let updatedCount = 0;
  const matchEvents = [];
  await run('BEGIN TRANSACTION');
  try {
    for (const message of messages) {
      const match = await suggestMatterForWorkEmail(req, message);
      const existing = await get(
        'SELECT id FROM work_email_messages WHERE connectedAccountId=? AND providerMessageId=?',
        [account.id, message.providerMessageId],
      );
      if (existing) {
        await run(
          `UPDATE work_email_messages
           SET providerThreadId=?, sender=?, recipientsSummary=?, subject=?, snippet=?, receivedAt=?, hasAttachments=?, labelsJson=?, foldersJson=?, matchedMatterId=?, matchConfidence=?, matchReason=?, updatedAt=?
           WHERE id=?`,
          [
            message.providerThreadId,
            message.sender,
            message.recipientsSummary,
            message.subject,
            message.snippet,
            message.receivedAt,
            message.hasAttachments,
            message.labelsJson,
            message.foldersJson,
            match?.matterId || '',
            match?.confidence || null,
            match?.reason || '',
            now,
            existing.id,
          ],
        );
        updatedCount += 1;
        if (match?.matterId) matchEvents.push({ messageId: existing.id, ...match });
      } else {
        const id = genId('WEM');
        await run(
          `INSERT INTO work_email_messages
           (id,connectedAccountId,userId,provider,providerAccountId,providerMessageId,providerThreadId,sender,recipientsSummary,subject,snippet,receivedAt,hasAttachments,labelsJson,foldersJson,matchedMatterId,matchConfidence,matchReason,importedAt,updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            account.id,
            req.user.userId,
            account.provider,
            account.providerAccountId || '',
            message.providerMessageId,
            message.providerThreadId,
            message.sender,
            message.recipientsSummary,
            message.subject,
            message.snippet,
            message.receivedAt,
            message.hasAttachments,
            message.labelsJson,
            message.foldersJson,
            match?.matterId || '',
            match?.confidence || null,
            match?.reason || '',
            now,
            now,
          ],
        );
        importedCount += 1;
        if (match?.matterId) matchEvents.push({ messageId: id, ...match });
      }
    }
    await upsertWorkEmailSyncState(account.id, {
      cursor: providerResult?.cursor || '',
      lastAttemptAt: attemptAt,
      lastSuccessAt: now,
      lastError: '',
      lastImportedCount: importedCount + updatedCount,
    });
    await run('UPDATE connected_accounts SET lastSyncAt=?, lastError="", updatedAt=? WHERE id=?', [now, now, account.id]);
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  }
  const totalRow = await get('SELECT COUNT(*) count FROM work_email_messages WHERE connectedAccountId=?', [account.id]);
  return {
    summary: {
      importedCount,
      updatedCount,
      totalMessages: Number(totalRow?.count || 0),
      lastSuccessAt: now,
    },
    matchEvents,
  };
}

async function recordWorkEmailSyncFailure(req, connectedAccountId, reason, attemptAt) {
  const now = new Date().toISOString();
  await upsertWorkEmailSyncState(connectedAccountId, {
    cursor: '',
    lastAttemptAt: attemptAt || now,
    lastSuccessAt: '',
    lastError: reason,
    lastImportedCount: 0,
  }).catch(() => {});
  await run('UPDATE connected_accounts SET lastError=?, updatedAt=? WHERE id=?', [reason, now, connectedAccountId]).catch(() => {});
  await recordAuditEvent(req, {
    action: 'work_email_sync_failed',
    entityType: 'connected_account',
    entityId: connectedAccountId,
    metadata: { connectedAccountId, reason },
  }).catch(() => {});
}

function normalizeCalendarEvent(event = {}) {
  return {
    providerEventId: String(event.providerEventId || '').trim(),
    calendarId: String(event.calendarId || 'primary').trim(),
    calendarName: String(event.calendarName || '').trim(),
    subject: String(event.subject || '').trim(),
    startTime: String(event.startTime || '').trim(),
    endTime: String(event.endTime || '').trim(),
    location: String(event.location || '').trim(),
    meetingLink: String(event.meetingLink || '').trim(),
    organizer: String(event.organizer || '').trim(),
    attendeesSummary: String(event.attendeesSummary || '').trim(),
    descriptionSnippet: String(event.descriptionSnippet || '').trim().replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 500),
    providerUpdatedAt: String(event.providerUpdatedAt || '').trim(),
  };
}

function publicCalendarEvent(row = {}) {
  return {
    id: row.id,
    connectedAccountId: row.connectedAccountId,
    provider: row.provider,
    providerAccountId: row.providerAccountId || '',
    providerEventId: row.providerEventId || '',
    calendarId: row.calendarId || '',
    calendarName: row.calendarName || '',
    subject: row.subject || '',
    startTime: row.startTime || '',
    endTime: row.endTime || '',
    location: row.location || '',
    meetingLink: row.meetingLink || '',
    organizer: row.organizer || '',
    attendeesSummary: row.attendeesSummary || '',
    descriptionSnippet: row.descriptionSnippet || '',
    matchedMatterId: row.matchedMatterId || '',
    matchedMatterTitle: row.matchedMatterTitle || '',
    matchedClientName: row.matchedClientName || '',
    matchConfidence: row.matchConfidence === null || row.matchConfidence === undefined ? null : Number(row.matchConfidence),
    matchReason: row.matchReason || '',
    confirmedMatterId: row.confirmedMatterId || '',
    confirmedMatterTitle: row.confirmedMatterTitle || '',
    confirmedClientName: row.confirmedClientName || '',
    confirmedAt: row.confirmedAt || '',
    confirmedBy: row.confirmedBy || '',
    confirmationStatus: row.confirmedMatterId ? (row.confirmationStatus || 'confirmed') : '',
    confirmationSource: confirmationSourceFor(row),
    importedAt: row.importedAt || '',
    updatedAt: row.updatedAt || '',
    accountEmail: row.accountEmail || '',
    accountProvider: row.accountProvider || row.provider || '',
  };
}

async function suggestMatterForCalendarEvent(req, event) {
  const params = [];
  let where = '';
  if (req.user.role === 'advocate') {
    where = 'WHERE m.assignedTo=?';
    params.push(req.user.fullName || '');
  }
  const matters = await all(
    `SELECT m.id, m.reference, m.caseNo, m.title, c.name clientName, c.email clientEmail
     FROM matters m
     LEFT JOIN clients c ON c.id=m.clientId
     ${where}`,
    params,
  );
  const haystack = [
    event.subject,
    event.descriptionSnippet,
    event.location,
    event.organizer,
    event.attendeesSummary,
  ].map(value => cleanWorkEmailText(value, 1000).toLowerCase()).join(' ');
  const addressText = [event.organizer, event.attendeesSummary].join(' ').toLowerCase();
  let best = null;
  for (const matter of matters) {
    const reference = cleanWorkEmailText(matter.reference, 120).toLowerCase();
    const caseNo = cleanWorkEmailText(matter.caseNo, 120).toLowerCase();
    if (reference && haystack.includes(reference)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.95, reason: `Reference match: ${matter.reference}` });
      continue;
    }
    if (caseNo && haystack.includes(caseNo)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.92, reason: `Case number match: ${matter.caseNo}` });
      continue;
    }

    const clientEmail = cleanWorkEmailText(matter.clientEmail, 255).toLowerCase();
    if (clientEmail && addressText.includes(clientEmail)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.88, reason: `Client email match: ${matter.clientEmail}` });
      continue;
    }
    const clientDomain = emailDomain(clientEmail);
    if (clientDomain && !GENERIC_EMAIL_DOMAINS.has(clientDomain) && addressText.includes(clientDomain)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.72, reason: `Client email domain match: ${clientDomain}` });
    }

    const clientWords = wordsForMatch(matter.clientName, 3);
    if (clientWords.length && clientWords.every(word => haystack.includes(word))) {
      best = bestMatterCandidate(best, { matter, confidence: 0.74, reason: `Client name match: ${matter.clientName}` });
    }

    const titleWords = wordsForMatch(matter.title, 4).slice(0, 5);
    const titleHits = titleWords.filter(word => haystack.includes(word)).length;
    if (titleWords.length >= 2 && titleHits >= Math.min(2, titleWords.length)) {
      best = bestMatterCandidate(best, { matter, confidence: 0.66, reason: `Matter title terms match: ${matter.title}` });
    }
  }
  if (!best || Number(best.confidence || 0) < 0.6) return null;
  return {
    matterId: best.matter.id,
    matterTitle: best.matter.title || '',
    clientName: best.matter.clientName || '',
    confidence: Number(best.confidence.toFixed(2)),
    reason: best.reason,
  };
}

async function upsertWorkCalendarSyncState(connectedAccountId, { cursor = '', lastAttemptAt, lastSuccessAt = '', lastError = '', lastImportedCount = 0 }) {
  const now = new Date().toISOString();
  const existing = await get('SELECT id FROM connected_account_sync_state WHERE connectedAccountId=? AND syncType=?', [connectedAccountId, WORK_CALENDAR_SYNC_TYPE]);
  const cursorJson = JSON.stringify({ cursor: cleanWorkEmailText(cursor, 4000) });
  if (existing) {
    await run(
      `UPDATE connected_account_sync_state
       SET cursorJson=?, lastAttemptAt=?, lastSuccessAt=?, lastError=?, lastImportedCount=?, updatedAt=?
       WHERE id=?`,
      [cursorJson, lastAttemptAt || now, lastSuccessAt, lastError, Number(lastImportedCount || 0), now, existing.id],
    );
    return existing.id;
  }
  const id = genId('CAS');
  await run(
    `INSERT INTO connected_account_sync_state
     (id,connectedAccountId,syncType,cursorJson,lastAttemptAt,lastSuccessAt,lastError,lastImportedCount,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, connectedAccountId, WORK_CALENDAR_SYNC_TYPE, cursorJson, lastAttemptAt || now, lastSuccessAt, lastError, Number(lastImportedCount || 0), now, now],
  );
  return id;
}

async function storeWorkCalendarMetadata(req, account, providerResult, attemptAt) {
  const events = (Array.isArray(providerResult?.events) ? providerResult.events : [])
    .map(normalizeCalendarEvent)
    .filter(event => event.providerEventId);
  const now = new Date().toISOString();
  let importedCount = 0;
  let updatedCount = 0;
  const matchEvents = [];
  await run('BEGIN TRANSACTION');
  try {
    for (const event of events) {
      const match = await suggestMatterForCalendarEvent(req, event);
      const existing = await get(
        'SELECT id FROM work_calendar_events WHERE connectedAccountId=? AND providerEventId=?',
        [account.id, event.providerEventId],
      );
      if (existing) {
        await run(
          `UPDATE work_calendar_events
           SET calendarId=?, calendarName=?, subject=?, startTime=?, endTime=?, location=?, meetingLink=?, organizer=?, attendeesSummary=?, descriptionSnippet=?, providerUpdatedAt=?, matchedMatterId=?, matchConfidence=?, matchReason=?, updatedAt=?
           WHERE id=?`,
          [
            event.calendarId,
            event.calendarName,
            event.subject,
            event.startTime,
            event.endTime,
            event.location,
            event.meetingLink,
            event.organizer,
            event.attendeesSummary,
            event.descriptionSnippet,
            event.providerUpdatedAt,
            match?.matterId || '',
            match?.confidence || null,
            match?.reason || '',
            now,
            existing.id,
          ],
        );
        updatedCount += 1;
        if (match?.matterId) matchEvents.push({ eventId: existing.id, ...match });
      } else {
        const id = genId('WCE');
        await run(
          `INSERT INTO work_calendar_events
           (id,connectedAccountId,userId,provider,providerAccountId,providerEventId,calendarId,calendarName,subject,startTime,endTime,location,meetingLink,organizer,attendeesSummary,descriptionSnippet,providerUpdatedAt,matchedMatterId,matchConfidence,matchReason,importedAt,updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            account.id,
            req.user.userId,
            account.provider,
            account.providerAccountId || '',
            event.providerEventId,
            event.calendarId,
            event.calendarName,
            event.subject,
            event.startTime,
            event.endTime,
            event.location,
            event.meetingLink,
            event.organizer,
            event.attendeesSummary,
            event.descriptionSnippet,
            event.providerUpdatedAt,
            match?.matterId || '',
            match?.confidence || null,
            match?.reason || '',
            now,
            now,
          ],
        );
        importedCount += 1;
        if (match?.matterId) matchEvents.push({ eventId: id, ...match });
      }
    }
    await upsertWorkCalendarSyncState(account.id, {
      cursor: providerResult?.cursor || '',
      lastAttemptAt: attemptAt,
      lastSuccessAt: now,
      lastError: '',
      lastImportedCount: importedCount + updatedCount,
    });
    await run('UPDATE connected_accounts SET lastSyncAt=?, lastError="", updatedAt=? WHERE id=?', [now, now, account.id]);
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  }
  const totalRow = await get('SELECT COUNT(*) count FROM work_calendar_events WHERE connectedAccountId=?', [account.id]);
  return {
    summary: {
      importedCount,
      updatedCount,
      totalEvents: Number(totalRow?.count || 0),
      lastSuccessAt: now,
    },
    matchEvents,
  };
}

async function recordWorkCalendarSyncFailure(req, connectedAccountId, reason, attemptAt) {
  const now = new Date().toISOString();
  await upsertWorkCalendarSyncState(connectedAccountId, {
    cursor: '',
    lastAttemptAt: attemptAt || now,
    lastSuccessAt: '',
    lastError: reason,
    lastImportedCount: 0,
  }).catch(() => {});
  await run('UPDATE connected_accounts SET lastError=?, updatedAt=? WHERE id=?', [reason, now, connectedAccountId]).catch(() => {});
  await recordAuditEvent(req, {
    action: 'work_calendar_sync_failed',
    entityType: 'connected_account',
    entityId: connectedAccountId,
    metadata: { connectedAccountId, reason },
  }).catch(() => {});
}

async function workEmailMessageWithConfirmation(messageId, userId) {
  return get(
    `SELECT wem.*, ca.email accountEmail, ca.provider accountProvider, m.title matchedMatterTitle, c.name matchedClientName,
      wml.matterId confirmedMatterId, cm.title confirmedMatterTitle, cc.name confirmedClientName,
      wml.confirmedAt confirmedAt, wml.confirmedBy confirmedBy, wml.status confirmationStatus
     FROM work_email_messages wem
     LEFT JOIN connected_accounts ca ON ca.id=wem.connectedAccountId
     LEFT JOIN matters m ON m.id=wem.matchedMatterId
     LEFT JOIN clients c ON c.id=m.clientId
     ${activeMetadataLinkJoin('email', 'wem')}
     WHERE wem.id=? AND wem.userId=?`,
    [messageId, userId],
  );
}

async function workCalendarEventWithConfirmation(eventId, userId) {
  return get(
    `SELECT wce.*, ca.email accountEmail, ca.provider accountProvider, m.title matchedMatterTitle, c.name matchedClientName,
      wml.matterId confirmedMatterId, cm.title confirmedMatterTitle, cc.name confirmedClientName,
      wml.confirmedAt confirmedAt, wml.confirmedBy confirmedBy, wml.status confirmationStatus
     FROM work_calendar_events wce
     LEFT JOIN connected_accounts ca ON ca.id=wce.connectedAccountId
     LEFT JOIN matters m ON m.id=wce.matchedMatterId
     LEFT JOIN clients c ON c.id=m.clientId
     ${activeMetadataLinkJoin('calendar', 'wce')}
     WHERE wce.id=? AND wce.userId=?`,
    [eventId, userId],
  );
}

async function confirmWorkMetadataMatter(req, { sourceType, sourceId, connectedAccountId, suggestedMatterId, confidence, reason, selectedMatterId, auditAction, entityType }) {
  const requestedMatterId = String(selectedMatterId || '').trim();
  const suggestionMatterId = String(suggestedMatterId || '').trim();
  const matterId = requestedMatterId || suggestionMatterId;
  if (!matterId) return { ok: false, status: 400, error: 'matterId is required when no suggested matter is available.' };
  const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [matterId]);
  if (!matter) return { ok: false, status: 404, error: 'Matter not found.' };
  if (!(await canAccessMatter(req, matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, clientId: matter.clientId || '', metadata: { reason: 'insufficient permissions', route: `${sourceType}_metadata_confirm_matter` } }).catch(() => {});
    return { ok: false, status: 403, error: 'Matter access denied.' };
  }
  const now = new Date().toISOString();
  const confirmationSource = requestedMatterId && requestedMatterId !== suggestionMatterId ? 'manual_override' : 'suggested';
  const existingLinks = await all('SELECT id, matterId FROM work_metadata_matter_links WHERE sourceType=? AND sourceId=? AND status=?', [sourceType, sourceId, 'confirmed']);
  const linkId = genId('WML');
  await run('BEGIN TRANSACTION');
  try {
    await run(
      "UPDATE work_metadata_matter_links SET status='unlinked', unlinkedBy=?, unlinkedAt=?, updatedAt=? WHERE sourceType=? AND sourceId=? AND status='confirmed'",
      [req.user.userId || '', now, now, sourceType, sourceId],
    );
    await run(
      `INSERT INTO work_metadata_matter_links
       (id,sourceType,sourceId,matterId,suggestedMatterId,confidence,reason,status,confirmedBy,confirmedAt,unlinkedBy,unlinkedAt,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [linkId, sourceType, sourceId, matter.id, suggestionMatterId, confidence === null || confidence === undefined ? null : Number(confidence), reason || '', 'confirmed', req.user.userId || '', now, '', '', now, now],
    );
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  }
  await recordAuditEvent(req, {
    action: auditAction,
    entityType,
    entityId: sourceId,
    matterId: matter.id,
    clientId: matter.clientId || '',
    metadata: {
      sourceType,
      sourceId,
      connectedAccountId: connectedAccountId || '',
      matterId: matter.id,
      suggestedMatterId: suggestionMatterId,
      confidence: confidence === null || confidence === undefined ? null : Number(confidence),
      reason: reason || '',
      confirmationSource,
      previousMatterIds: existingLinks.map(link => link.matterId).filter(Boolean),
    },
  }).catch(() => {});
  return { ok: true };
}

async function unlinkWorkMetadataMatter(req, { sourceType, sourceId, connectedAccountId, auditAction, entityType }) {
  const now = new Date().toISOString();
  const existingLinks = await all(
    `SELECT wml.id, wml.matterId, m.clientId
     FROM work_metadata_matter_links wml
     LEFT JOIN matters m ON m.id=wml.matterId
     WHERE wml.sourceType=? AND wml.sourceId=? AND wml.status=?`,
    [sourceType, sourceId, 'confirmed'],
  );
  await run(
    "UPDATE work_metadata_matter_links SET status='unlinked', unlinkedBy=?, unlinkedAt=?, updatedAt=? WHERE sourceType=? AND sourceId=? AND status='confirmed'",
    [req.user.userId || '', now, now, sourceType, sourceId],
  );
  await recordAuditEvent(req, {
    action: auditAction,
    entityType,
    entityId: sourceId,
    matterId: existingLinks[0]?.matterId || '',
    clientId: existingLinks[0]?.clientId || '',
    metadata: {
      sourceType,
      sourceId,
      connectedAccountId: connectedAccountId || '',
      previousMatterIds: existingLinks.map(link => link.matterId).filter(Boolean),
      unlinkedCount: existingLinks.length,
    },
  }).catch(() => {});
  return { ok: true };
}

app.get('/api/connected-accounts', authenticate, requireStaff, async (req, res) => {
  const accounts = await oauth.getConnectedAccounts(req.user.userId);
  res.json(accounts);
});

app.post('/api/connected-accounts/:provider/start', authenticate, requireStaff, async (req, res) => {
  const provider = connectedAccountProvider(req.params.provider);
  if (!provider) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider: req.params.provider || '', reason: 'unsupported_provider' } }).catch(() => {});
    return res.status(400).json({ error: 'Unsupported provider' });
  }
  try {
    const state = signState(provider, { purpose: 'connected_account', userId: req.user.userId });
    const authorizationUrl = connectedAccountAuthorizationUrl(provider, state);
    await recordAuditEvent(req, { action: 'connected_account_start', entityType: 'connected_account', metadata: { provider } }).catch(() => {});
    res.json({ authorizationUrl });
  } catch (err) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: 'configuration_error' } }).catch(() => {});
    res.status(500).json({ error: 'Connected account OAuth is not configured.' });
  }
});

app.get('/api/connected-accounts/:provider/callback', async (req, res) => {
  const provider = connectedAccountProvider(req.params.provider);
  if (!provider) return res.redirect(connectedAccountCallbackUrl('', 'failed', 'unsupported_provider'));
  const { code, state, error: providerError } = req.query;
  const stateResult = await connectedAccountStateUser(req, provider, state);
  if (!stateResult.ok) return res.redirect(connectedAccountCallbackUrl(provider, 'failed', stateResult.error));
  if (providerError) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: 'provider_denied' } }).catch(() => {});
    return res.redirect(connectedAccountCallbackUrl(provider, 'failed', 'provider_denied'));
  }
  if (!code) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: 'missing_code' } }).catch(() => {});
    return res.redirect(connectedAccountCallbackUrl(provider, 'failed', 'missing_code'));
  }
  try {
    const profile = provider === 'google'
      ? await googleOAuth.handleConnectedCallback(code)
      : await microsoftOAuth.handleConnectedCallback(code);
    const result = await oauth.upsertConnectedAccount({ ...profile, provider, userId: stateResult.user.id });
    if (!result.ok) {
      await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: result.error } }).catch(() => {});
      return res.redirect(connectedAccountCallbackUrl(provider, 'failed', result.error));
    }
    await recordAuditEvent(req, {
      action: 'connected_account_connected',
      entityType: 'connected_account',
      entityId: result.account.id,
      metadata: { provider, connectedAccountId: result.account.id, email: result.account.email || '' },
    }).catch(() => {});
    res.redirect(connectedAccountCallbackUrl(provider, 'connected'));
  } catch (err) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', metadata: { provider, reason: 'exchange_or_store_failed' } }).catch(() => {});
    res.redirect(connectedAccountCallbackUrl(provider, 'failed', 'exchange_or_store_failed'));
  }
});

app.post('/api/connected-accounts/:id/disconnect', authenticate, requireStaff, async (req, res) => {
  const result = await oauth.disconnectConnectedAccount(req.user.userId, req.params.id);
  if (!result.ok) {
    await recordAuditEvent(req, { action: 'connected_account_failed', entityType: 'connected_account', entityId: req.params.id, metadata: { reason: result.error } }).catch(() => {});
    return res.status(404).json({ error: result.message });
  }
  await recordAuditEvent(req, {
    action: 'connected_account_disconnected',
    entityType: 'connected_account',
    entityId: result.account.id,
    metadata: { provider: result.account.provider, connectedAccountId: result.account.id, email: result.account.email || '' },
  }).catch(() => {});
  res.json(result.account);
});

app.post('/api/connected-accounts/:id/sync-email-metadata', authenticate, requireStaff, async (req, res) => {
  const attemptAt = new Date().toISOString();
  const credential = await oauth.getConnectedAccountSyncCredential(req.user.userId, req.params.id).catch(() => ({
    ok: false,
    status: 500,
    error: 'credential_read_failed',
    message: 'Connected account could not be read.',
  }));
  if (!credential.ok) {
    await recordAuditEvent(req, {
      action: 'work_email_sync_failed',
      entityType: 'connected_account',
      entityId: req.params.id,
      metadata: { connectedAccountId: req.params.id, reason: credential.error },
    }).catch(() => {});
    return res.status(credential.status || 400).json({ error: credential.message || 'Connected account cannot be synced.' });
  }

  const { account, tokens } = credential;
  await recordAuditEvent(req, {
    action: 'work_email_sync_started',
    entityType: 'connected_account',
    entityId: account.id,
    metadata: { provider: account.provider, connectedAccountId: account.id },
  }).catch(() => {});

  try {
    const stateRow = await get('SELECT cursorJson FROM connected_account_sync_state WHERE connectedAccountId=? AND syncType=?', [account.id, WORK_EMAIL_SYNC_TYPE]);
    const cursorState = parseWorkEmailCursor(stateRow?.cursorJson);
    const providerClient = workEmailProviderClient(account.provider);
    const providerResult = await providerClient.fetchEmailMetadata({
      accessToken: tokens.accessToken,
      cursor: cursorState.cursor || '',
      limit: WORK_EMAIL_SYNC_LIMIT,
    });
    const stored = await storeWorkEmailMetadata(req, account, providerResult, attemptAt);
    if (stored.summary.importedCount || stored.summary.updatedCount) {
      await recordAuditEvent(req, {
        action: 'work_email_metadata_imported',
        entityType: 'connected_account',
        entityId: account.id,
        metadata: {
          provider: account.provider,
          connectedAccountId: account.id,
          importedCount: stored.summary.importedCount,
          updatedCount: stored.summary.updatedCount,
        },
      }).catch(() => {});
    }
    for (const match of stored.matchEvents) {
      await recordAuditEvent(req, {
        action: 'work_email_match_suggested',
        entityType: 'work_email_message',
        entityId: match.messageId,
        matterId: match.matterId,
        metadata: {
          connectedAccountId: account.id,
          workEmailMessageId: match.messageId,
          matterId: match.matterId,
          confidence: match.confidence,
          reason: match.reason,
        },
      }).catch(() => {});
    }
    await recordAuditEvent(req, {
      action: 'work_email_sync_completed',
      entityType: 'connected_account',
      entityId: account.id,
      metadata: {
        provider: account.provider,
        connectedAccountId: account.id,
        importedCount: stored.summary.importedCount,
        updatedCount: stored.summary.updatedCount,
        totalMessages: stored.summary.totalMessages,
      },
    }).catch(() => {});
    res.json(stored.summary);
  } catch (err) {
    await recordWorkEmailSyncFailure(req, account.id, 'sync_failed', attemptAt);
    res.status(502).json({ error: 'Email metadata sync failed.' });
  }
});

app.get('/api/work-email/messages/:id/matches', authenticate, requireStaff, async (req, res) => {
  const row = await get(
    `SELECT wem.id, wem.matchedMatterId, wem.matchConfidence, wem.matchReason, m.title matchedMatterTitle, c.name matchedClientName
     FROM work_email_messages wem
     LEFT JOIN matters m ON m.id=wem.matchedMatterId
     LEFT JOIN clients c ON c.id=m.clientId
     WHERE wem.id=? AND wem.userId=?`,
    [req.params.id, req.user.userId],
  );
  if (!row) return res.status(404).json({ error: 'Work email message not found.' });
  if (!row.matchedMatterId) return res.json([]);
  res.json([{
    matterId: row.matchedMatterId,
    matterTitle: row.matchedMatterTitle || '',
    clientName: row.matchedClientName || '',
    confidence: row.matchConfidence === null || row.matchConfidence === undefined ? null : Number(row.matchConfidence),
    reason: row.matchReason || '',
  }]);
});

app.post('/api/work-email/messages/:id/confirm-matter', authenticate, requireStaff, async (req, res) => {
  const row = await get('SELECT * FROM work_email_messages WHERE id=? AND userId=?', [req.params.id, req.user.userId]);
  if (!row) return res.status(404).json({ error: 'Work email message not found.' });
  const result = await confirmWorkMetadataMatter(req, {
    sourceType: 'email',
    sourceId: row.id,
    connectedAccountId: row.connectedAccountId,
    suggestedMatterId: row.matchedMatterId || '',
    confidence: row.matchConfidence,
    reason: row.matchReason || '',
    selectedMatterId: req.body?.matterId,
    auditAction: 'work_email_match_confirmed',
    entityType: 'work_email_message',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  const updated = await workEmailMessageWithConfirmation(row.id, req.user.userId);
  res.json(publicWorkEmailMessage(updated));
});

app.post('/api/work-email/messages/:id/unlink-matter', authenticate, requireStaff, async (req, res) => {
  const row = await get('SELECT * FROM work_email_messages WHERE id=? AND userId=?', [req.params.id, req.user.userId]);
  if (!row) return res.status(404).json({ error: 'Work email message not found.' });
  await unlinkWorkMetadataMatter(req, {
    sourceType: 'email',
    sourceId: row.id,
    connectedAccountId: row.connectedAccountId,
    auditAction: 'work_email_match_unlinked',
    entityType: 'work_email_message',
  });
  const updated = await workEmailMessageWithConfirmation(row.id, req.user.userId);
  res.json(publicWorkEmailMessage(updated));
});

app.get('/api/work-email/messages', authenticate, requireStaff, async (req, res) => {
  const filters = ['wem.userId=?'];
  const params = [req.user.userId];
  if (req.query.connectedAccountId) {
    filters.push('wem.connectedAccountId=?');
    params.push(String(req.query.connectedAccountId));
  }
  if (req.query.matchedMatterId) {
    filters.push('wem.matchedMatterId=?');
    params.push(String(req.query.matchedMatterId));
  }
  if (req.query.q) {
    const q = `%${String(req.query.q).trim()}%`;
    filters.push('(wem.sender LIKE ? OR wem.recipientsSummary LIKE ? OR wem.subject LIKE ? OR wem.snippet LIKE ?)');
    params.push(q, q, q, q);
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const rows = await all(
    `SELECT wem.*, ca.email accountEmail, ca.provider accountProvider, m.title matchedMatterTitle, c.name matchedClientName,
       wml.matterId confirmedMatterId, cm.title confirmedMatterTitle, cc.name confirmedClientName,
       wml.confirmedAt confirmedAt, wml.confirmedBy confirmedBy, wml.status confirmationStatus
     FROM work_email_messages wem
     LEFT JOIN connected_accounts ca ON ca.id=wem.connectedAccountId
     LEFT JOIN matters m ON m.id=wem.matchedMatterId
     LEFT JOIN clients c ON c.id=m.clientId
     ${activeMetadataLinkJoin('email', 'wem')}
     WHERE ${filters.join(' AND ')}
     ORDER BY COALESCE(wem.receivedAt, wem.importedAt) DESC, wem.importedAt DESC
     LIMIT ?`,
    [...params, limit],
  );
  res.json(rows.map(publicWorkEmailMessage));
});

app.post('/api/connected-accounts/:id/sync-calendar-metadata', authenticate, requireStaff, async (req, res) => {
  const attemptAt = new Date().toISOString();
  const credential = await oauth.getConnectedAccountSyncCredential(req.user.userId, req.params.id).catch(() => ({
    ok: false,
    status: 500,
    error: 'credential_read_failed',
    message: 'Connected account could not be read.',
  }));
  if (!credential.ok) {
    await recordAuditEvent(req, {
      action: 'work_calendar_sync_failed',
      entityType: 'connected_account',
      entityId: req.params.id,
      metadata: { connectedAccountId: req.params.id, reason: credential.error },
    }).catch(() => {});
    return res.status(credential.status || 400).json({ error: credential.message || 'Connected account cannot be synced.' });
  }

  const { account, tokens } = credential;
  await recordAuditEvent(req, {
    action: 'work_calendar_sync_started',
    entityType: 'connected_account',
    entityId: account.id,
    metadata: { provider: account.provider, connectedAccountId: account.id },
  }).catch(() => {});

  try {
    const stateRow = await get('SELECT cursorJson FROM connected_account_sync_state WHERE connectedAccountId=? AND syncType=?', [account.id, WORK_CALENDAR_SYNC_TYPE]);
    const cursorState = parseWorkEmailCursor(stateRow?.cursorJson);
    const providerClient = workCalendarProviderClient(account.provider);
    const providerResult = await providerClient.fetchCalendarMetadata({
      accessToken: tokens.accessToken,
      startDate: cursorState.startDate || '',
      endDate: cursorState.endDate || '',
      limit: 25,
    });
    const stored = await storeWorkCalendarMetadata(req, account, providerResult, attemptAt);
    if (stored.summary.importedCount || stored.summary.updatedCount) {
      await recordAuditEvent(req, {
        action: 'work_calendar_metadata_imported',
        entityType: 'connected_account',
        entityId: account.id,
        metadata: {
          provider: account.provider,
          connectedAccountId: account.id,
          importedCount: stored.summary.importedCount,
          updatedCount: stored.summary.updatedCount,
        },
      }).catch(() => {});
    }
    for (const match of stored.matchEvents) {
      await recordAuditEvent(req, {
        action: 'work_calendar_match_suggested',
        entityType: 'work_calendar_event',
        entityId: match.eventId,
        matterId: match.matterId,
        metadata: {
          connectedAccountId: account.id,
          workCalendarEventId: match.eventId,
          matterId: match.matterId,
          confidence: match.confidence,
          reason: match.reason,
        },
      }).catch(() => {});
    }
    await recordAuditEvent(req, {
      action: 'work_calendar_sync_completed',
      entityType: 'connected_account',
      entityId: account.id,
      metadata: {
        provider: account.provider,
        connectedAccountId: account.id,
        importedCount: stored.summary.importedCount,
        updatedCount: stored.summary.updatedCount,
        totalEvents: stored.summary.totalEvents,
      },
    }).catch(() => {});
    res.json(stored.summary);
  } catch (err) {
    await recordWorkCalendarSyncFailure(req, account.id, 'sync_failed', attemptAt);
    res.status(502).json({ error: 'Calendar metadata sync failed.' });
  }
});

app.get('/api/work-calendar/events/:id/matches', authenticate, requireStaff, async (req, res) => {
  const row = await get(
    `SELECT wce.id, wce.matchedMatterId, wce.matchConfidence, wce.matchReason, m.title matchedMatterTitle, c.name matchedClientName
     FROM work_calendar_events wce
     LEFT JOIN matters m ON m.id=wce.matchedMatterId
     LEFT JOIN clients c ON c.id=m.clientId
     WHERE wce.id=? AND wce.userId=?`,
    [req.params.id, req.user.userId],
  );
  if (!row) return res.status(404).json({ error: 'Work calendar event not found.' });
  if (!row.matchedMatterId) return res.json([]);
  res.json([{
    matterId: row.matchedMatterId,
    matterTitle: row.matchedMatterTitle || '',
    clientName: row.matchedClientName || '',
    confidence: row.matchConfidence === null || row.matchConfidence === undefined ? null : Number(row.matchConfidence),
    reason: row.matchReason || '',
  }]);
});

app.post('/api/work-calendar/events/:id/confirm-matter', authenticate, requireStaff, async (req, res) => {
  const row = await get('SELECT * FROM work_calendar_events WHERE id=? AND userId=?', [req.params.id, req.user.userId]);
  if (!row) return res.status(404).json({ error: 'Work calendar event not found.' });
  const result = await confirmWorkMetadataMatter(req, {
    sourceType: 'calendar',
    sourceId: row.id,
    connectedAccountId: row.connectedAccountId,
    suggestedMatterId: row.matchedMatterId || '',
    confidence: row.matchConfidence,
    reason: row.matchReason || '',
    selectedMatterId: req.body?.matterId,
    auditAction: 'work_calendar_match_confirmed',
    entityType: 'work_calendar_event',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  const updated = await workCalendarEventWithConfirmation(row.id, req.user.userId);
  res.json(publicCalendarEvent(updated));
});

app.post('/api/work-calendar/events/:id/unlink-matter', authenticate, requireStaff, async (req, res) => {
  const row = await get('SELECT * FROM work_calendar_events WHERE id=? AND userId=?', [req.params.id, req.user.userId]);
  if (!row) return res.status(404).json({ error: 'Work calendar event not found.' });
  await unlinkWorkMetadataMatter(req, {
    sourceType: 'calendar',
    sourceId: row.id,
    connectedAccountId: row.connectedAccountId,
    auditAction: 'work_calendar_match_unlinked',
    entityType: 'work_calendar_event',
  });
  const updated = await workCalendarEventWithConfirmation(row.id, req.user.userId);
  res.json(publicCalendarEvent(updated));
});

app.get('/api/work-calendar/events', authenticate, requireStaff, async (req, res) => {
  const filters = ['wce.userId=?'];
  const params = [req.user.userId];
  if (req.query.connectedAccountId) {
    filters.push('wce.connectedAccountId=?');
    params.push(String(req.query.connectedAccountId));
  }
  if (req.query.matchedMatterId) {
    filters.push('wce.matchedMatterId=?');
    params.push(String(req.query.matchedMatterId));
  }
  if (req.query.q) {
    const q = `%${String(req.query.q).trim()}%`;
    filters.push('(wce.subject LIKE ? OR wce.location LIKE ? OR wce.organizer LIKE ? OR wce.attendeesSummary LIKE ?)');
    params.push(q, q, q, q);
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const rows = await all(
    `SELECT wce.*, ca.email accountEmail, ca.provider accountProvider, m.title matchedMatterTitle, c.name matchedClientName,
       wml.matterId confirmedMatterId, cm.title confirmedMatterTitle, cc.name confirmedClientName,
       wml.confirmedAt confirmedAt, wml.confirmedBy confirmedBy, wml.status confirmationStatus
     FROM work_calendar_events wce
     LEFT JOIN connected_accounts ca ON ca.id=wce.connectedAccountId
     LEFT JOIN matters m ON m.id=wce.matchedMatterId
     LEFT JOIN clients c ON c.id=m.clientId
     ${activeMetadataLinkJoin('calendar', 'wce')}
     WHERE ${filters.join(' AND ')}
     ORDER BY COALESCE(wce.startTime, wce.importedAt) DESC, wce.importedAt DESC
     LIMIT ?`,
    [...params, limit],
  );
  res.json(rows.map(publicCalendarEvent));
});

app.use('/api', authenticate);

app.get('/api/auth/me', async (req, res) => {
  const user = await get('SELECT id,email,fullName,role,clientId,createdAt,(CASE WHEN avatar IS NOT NULL THEN 1 ELSE 0 END) hasAvatar FROM users WHERE id=?', [req.user.userId]);
  user ? res.json({ ...user, name: user.fullName, hasAvatar: Boolean(user.hasAvatar) }) : res.status(404).json({ error: 'User not found' });
});
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return res.status(400).json({ error: 'currentPassword and newPassword must be strings' });
    if (currentPassword.length > 128 || newPassword.length > 128) return res.status(400).json({ error: 'Password must not exceed 128 characters' });
    const user = await get('SELECT id,password,role FROM users WHERE id=?', [req.user.userId]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!(await verifyPassword(currentPassword, user.password))) return res.status(401).json({ error: 'Current password is incorrect' });
    if (await verifyPassword(newPassword, user.password)) return res.status(400).json({ error: 'New password must be different from current password' });
    const passwordPolicy = validatePasswordPolicy(newPassword);
    if (!passwordPolicy.ok) return res.status(400).json({ error: 'Password does not meet security requirements', details: passwordPolicy.errors });
    const hashedPassword = await hashPassword(newPassword);
    await run('UPDATE users SET password=?, tokenVersion = COALESCE(tokenVersion, 1) + 1 WHERE id=?', [hashedPassword, req.user.userId]);
    await recordAuditEvent(req, { action: 'password_changed', entityType: 'user', entityId: req.user.userId, metadata: { role: req.user.role } }).catch(() => {});
    res.json({ message: 'Password changed successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/auth/users', requireAdmin, async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true';
  const sql = includeInactive
    ? 'SELECT id,email,fullName,role,clientId,createdAt,isActive,(CASE WHEN avatar IS NOT NULL THEN 1 ELSE 0 END) hasAvatar FROM users ORDER BY createdAt DESC'
    : 'SELECT id,email,fullName,role,clientId,createdAt,isActive,(CASE WHEN avatar IS NOT NULL THEN 1 ELSE 0 END) hasAvatar FROM users WHERE COALESCE(isActive,1)=1 ORDER BY createdAt DESC';
  const users = await all(sql);
  res.json(users.map(u => ({ ...u, isActive: Boolean(u.isActive ?? 1), hasAvatar: Boolean(u.hasAvatar) })));
});
app.post('/api/auth/register', requireAdmin, validate(registerValidation), async (req, res) => {
  try {
    const { email, password, fullName, role = 'assistant', clientId = '' } = req.body;
    if (!email || !password || !fullName) return res.status(400).json({ error: 'email, password and fullName are required' });
    const passwordPolicy = validatePasswordPolicy(password);
    if (!passwordPolicy.ok) return res.status(400).json({ error: 'Password does not meet security requirements', details: passwordPolicy.errors });
    if (!['advocate', 'assistant', 'admin', 'client'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role === 'client' && !clientId) return res.status(400).json({ error: 'Client users must be linked to a client record' });
    const id = genId('U');
    const createdAt = new Date().toISOString();
    await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt) VALUES (?,?,?,?,?,?,?)', [id, email, await hashPassword(password), fullName, role, role === 'client' ? clientId : '', createdAt]);
    await logAudit(req, 'create', 'user', id, `Created ${role} user ${email}`);
    await recordAuditEvent(req, { action: 'user_created', entityType: 'user', entityId: id, metadata: { role: role || '', email: email || '', fullName: fullName || '' } }).catch(() => {});
    res.json({ id, email, fullName, name: fullName, role, clientId: role === 'client' ? clientId : '', createdAt });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/auth/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot delete your own account' });
  const user = await get('SELECT id,email,fullName,role FROM users WHERE id=?', [req.params.id]);
  await run('BEGIN TRANSACTION');
  try {
    await run('DELETE FROM work_email_messages WHERE connectedAccountId IN (SELECT id FROM connected_accounts WHERE userId=?)', [req.params.id]);
    await run('DELETE FROM connected_account_sync_state WHERE connectedAccountId IN (SELECT id FROM connected_accounts WHERE userId=?)', [req.params.id]);
    await run('DELETE FROM connected_account_tokens WHERE connectedAccountId IN (SELECT id FROM connected_accounts WHERE userId=?)', [req.params.id]);
    await run('DELETE FROM connected_accounts WHERE userId=?', [req.params.id]);
    await run('DELETE FROM oauth_accounts WHERE userId=?', [req.params.id]);
    await run('DELETE FROM users WHERE id=?', [req.params.id]);
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  }
    await logAudit(req, 'delete', 'user', req.params.id, `Deleted user ${user?.email || req.params.id}`);
    await recordAuditEvent(req, { action: 'user_deactivated', entityType: 'user', entityId: req.params.id, metadata: { role: user?.role || '', email: user?.email || '' } }).catch(() => {});
    res.json({ id: req.params.id, deleted: true });
  });

  app.patch('/api/auth/users/:id/role', requireAdmin, async (req, res) => {
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot change your own role' });
    const { role } = req.body;
    if (!['admin', 'advocate', 'assistant', 'client'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const user = await get('SELECT id, email, role as oldRole FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.oldRole === role) return res.json({ id: user.id, email: user.email, role, message: 'Role unchanged' });
    // Prevent removing the last active admin
    if (user.oldRole === 'admin' && role !== 'admin') {
      const adminCount = await get('SELECT COUNT(*) as count FROM users WHERE role=? AND isActive=1', ['admin']);
      if (adminCount.count <= 1) return res.status(400).json({ error: 'Cannot remove the last active admin' });
    }
    await run('UPDATE users SET role=? WHERE id=?', [role, req.params.id]);
    await logAudit(req, 'update', 'user', req.params.id, `Changed role from ${user.oldRole} to ${role}`);
    await recordAuditEvent(req, { action: 'user_role_changed', entityType: 'user', entityId: req.params.id, metadata: { oldRole: user.oldRole, newRole: role, email: user.email || '' } }).catch(() => {});
    const updated = await get('SELECT id, email, fullName, role, clientId, createdAt, isActive FROM users WHERE id=?', [req.params.id]);
    res.json({ id: updated.id, email: updated.email, fullName: updated.fullName, role: updated.role, clientId: updated.clientId || '', createdAt: updated.createdAt, isActive: Boolean(updated.isActive) });
  });

  app.patch('/api/auth/users/:id/toggle-active', requireAdmin, async (req, res) => {
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot deactivate your own account' });
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be a boolean' });
    const user = await get('SELECT id, email, role, isActive as wasActive FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (Boolean(user.wasActive) === isActive) return res.json({ id: user.id, email: user.email, role: user.role, isActive, message: 'No change' });
    // Prevent deactivating the last active admin
    if (isActive === false && user.role === 'admin') {
      const activeAdminCount = await get('SELECT COUNT(*) as count FROM users WHERE role=? AND isActive=1', ['admin']);
      if (activeAdminCount.count <= 1) return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
    }
    await run('UPDATE users SET isActive=? WHERE id=?', [isActive ? 1 : 0, req.params.id]);
    const action = isActive ? 'user_activated' : 'user_deactivated';
    await logAudit(req, 'update', 'user', req.params.id, `${isActive ? 'Activated' : 'Deactivated'} user ${user.email}`);
    await recordAuditEvent(req, { action, entityType: 'user', entityId: req.params.id, metadata: { role: user.role, email: user.email || '', wasActive: Boolean(user.wasActive), isActive } }).catch(() => {});
    const updated = await get('SELECT id, email, fullName, role, clientId, createdAt, isActive FROM users WHERE id=?', [req.params.id]);
    res.json({ id: updated.id, email: updated.email, fullName: updated.fullName, role: updated.role, clientId: updated.clientId || '', createdAt: updated.createdAt, isActive: Boolean(updated.isActive) });
  });

// OAuth account management (staff only)
app.get('/api/auth/oauth/accounts', requireStaff, async (req, res) => {
  const accounts = await oauth.getLinkedAccounts(req.user.userId);
  res.json(accounts);
});
app.delete('/api/auth/oauth/accounts/:provider', requireStaff, async (req, res) => {
  if (!['google', 'microsoft'].includes(req.params.provider)) return res.status(400).json({ error: 'Unknown provider' });
  const result = await oauth.unlinkOAuthAccount(req.user.userId, req.params.provider);
  if (!result.ok) return res.status(404).json({ error: result.message });
  await recordAuditEvent(req, { action: 'oauth_account_unlinked', entityType: 'oauth', metadata: { provider: req.params.provider } }).catch(() => {});
  res.json({ ok: true, provider: req.params.provider });
});

// User avatar routes — BLOB storage, no external dependency
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_UPLOAD_BODY_LIMIT = '768kb';
const AVATAR_ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const avatarUploadBody = express.raw({
  type: req => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    return contentType.startsWith('multipart/form-data') || contentType.startsWith('image/');
  },
  limit: AVATAR_UPLOAD_BODY_LIMIT,
});

function avatarValidationError(message) {
  const err = new Error(message);
  err.isAvatarValidation = true;
  return err;
}

function decodeAvatarBase64(data) {
  try {
    const raw = String(data);
    const payload = (raw.includes(',') ? raw.split(',').pop() : raw).replace(/\s/g, '');
    if (!payload) throw new Error('empty');
    if (!/^[A-Za-z0-9+/]+=*$/.test(payload) || payload.length % 4 === 1) throw new Error('invalid base64');
    return Buffer.from(payload, 'base64');
  } catch {
    throw avatarValidationError('Invalid image data');
  }
}

function parseMultipartAvatar(buffer, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match?.[1] || match?.[2];
  if (!boundary) throw avatarValidationError('Avatar file is required');
  const marker = Buffer.from(`--${boundary}`);
  let offset = 0;
  while (offset < buffer.length) {
    const start = buffer.indexOf(marker, offset);
    if (start === -1) break;
    let partStart = start + marker.length;
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) break;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;
    const next = buffer.indexOf(marker, partStart);
    if (next === -1) break;
    let partEnd = next;
    if (buffer[partEnd - 2] === 13 && buffer[partEnd - 1] === 10) partEnd -= 2;
    const part = buffer.slice(partStart, partEnd);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString('latin1');
      if (/content-disposition:[^\r\n]*filename=/i.test(headers)) {
        const typeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
        return {
          buffer: part.slice(headerEnd + 4),
          mimeType: typeMatch?.[1] || '',
        };
      }
    }
    offset = next;
  }
  throw avatarValidationError('Avatar file is required');
}

function readAvatarUpload(req) {
  if (Buffer.isBuffer(req.body)) {
    const contentType = String(req.headers['content-type'] || '');
    const normalizedContentType = contentType.toLowerCase();
    if (normalizedContentType.startsWith('multipart/form-data')) return parseMultipartAvatar(req.body, contentType);
    if (normalizedContentType.startsWith('image/')) return { buffer: req.body, mimeType: normalizedContentType.split(';')[0] };
  }
  const { data, mimeType } = req.body || {};
  if (!data || !mimeType) throw avatarValidationError('data and mimeType are required');
  return { buffer: decodeAvatarBase64(data), mimeType };
}

function validateAvatarUpload(req) {
  const { buffer, mimeType } = readAvatarUpload(req);
  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!AVATAR_ALLOWED_MIME.has(normalizedMime)) throw avatarValidationError('Only image/jpeg, image/png, and image/webp are supported');
  if (!buffer || buffer.length === 0) throw avatarValidationError('Image data is empty');
  if (buffer.length > AVATAR_MAX_BYTES) throw avatarValidationError('Image exceeds 512 KB limit');
  return { buffer, normalizedMime };
}

function handleAvatarValidationError(res, err) {
  if (err?.type === 'entity.too.large') return res.status(400).json({ error: 'Image exceeds 512 KB limit' });
  if (err?.isAvatarValidation) return res.status(400).json({ error: err.message });
  return res.status(500).json({ error: err.message });
}

function sendAvatarResponse(res, row) {
  if (!row || !row.avatar) return res.status(404).json({ error: 'No avatar set' });
  res.setHeader('Content-Type', row.avatarMimeType || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.send(row.avatar);
}

async function linkedClientAvatarUser(clientId) {
  const client = await get('SELECT id FROM clients WHERE id=?', [clientId || '']);
  if (!client) return { status: 404, error: 'Client not found' };
  const user = await get("SELECT id, role, clientId FROM users WHERE role='client' AND clientId=? ORDER BY createdAt LIMIT 1", [clientId || '']);
  if (!user) return { status: 404, error: 'Linked client user not found' };
  return { user };
}

async function resolveAvatarTarget(req, res) {
  const target = await get('SELECT id, role FROM users WHERE id=?', [req.params.id]);
  if (!target) { res.status(404).json({ error: 'User not found' }); return null; }
  if (target.role === 'client') { res.status(400).json({ error: 'Client user avatars are not supported in this phase' }); return null; }
  const isAdmin = req.user.role === 'admin';
  const isSelf = req.user.userId === target.id;
  if (!isAdmin && !isSelf) { res.status(403).json({ error: 'Access denied' }); return null; }
  return target;
}

app.get('/api/users/:id/avatar', async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Access denied' });
  const isAdmin = req.user.role === 'admin';
  const isSelf = req.user.userId === req.params.id;
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'Access denied' });
  const row = await get('SELECT avatar, avatarMimeType FROM users WHERE id=?', [req.params.id]);
  return sendAvatarResponse(res, row);
});

app.post('/api/users/:id/avatar', async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Access denied' });
  const target = await resolveAvatarTarget(req, res);
  if (!target) return;
  try {
    const { buffer, normalizedMime } = validateAvatarUpload(req);
    await run('UPDATE users SET avatar=?, avatarMimeType=? WHERE id=?', [buffer, normalizedMime, target.id]);
    await recordAuditEvent(req, { action: 'user_avatar_updated', entityType: 'user', entityId: target.id, metadata: { role: target.role } }).catch(() => {});
    res.json({ id: target.id, hasAvatar: true, mimeType: normalizedMime });
  } catch (err) {
    handleAvatarValidationError(res, err);
  }
});

app.delete('/api/users/:id/avatar', async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Access denied' });
  const target = await resolveAvatarTarget(req, res);
  if (!target) return;
  await run("UPDATE users SET avatar=NULL, avatarMimeType='' WHERE id=?", [target.id]);
  await recordAuditEvent(req, { action: 'user_avatar_reset', entityType: 'user', entityId: target.id, metadata: { role: target.role } }).catch(() => {});
  res.json({ id: target.id, hasAvatar: false });
});

app.get('/api/auth/me/avatar', async (req, res) => {
  const row = await get('SELECT avatar, avatarMimeType FROM users WHERE id=?', [req.user.userId]);
  return sendAvatarResponse(res, row);
});

app.post('/api/auth/me/avatar', avatarUploadBody, async (req, res) => {
  try {
    const { buffer, normalizedMime } = validateAvatarUpload(req);
    await run('UPDATE users SET avatar=?, avatarMimeType=? WHERE id=?', [buffer, normalizedMime, req.user.userId]);
    const isClient = req.user.role === 'client';
    await recordAuditEvent(req, {
      action: isClient ? 'client_avatar_updated' : 'user_avatar_updated',
      entityType: 'user',
      entityId: req.user.userId,
      clientId: isClient ? req.user.clientId || '' : '',
      metadata: { role: req.user.role || '', clientId: isClient ? req.user.clientId || '' : '' },
    }).catch(() => {});
    res.json({ id: req.user.userId, hasAvatar: true, mimeType: normalizedMime });
  } catch (err) {
    handleAvatarValidationError(res, err);
  }
});

app.delete('/api/auth/me/avatar', async (req, res) => {
  await run("UPDATE users SET avatar=NULL, avatarMimeType='' WHERE id=?", [req.user.userId]);
  const isClient = req.user.role === 'client';
  await recordAuditEvent(req, {
    action: isClient ? 'client_avatar_reset' : 'user_avatar_reset',
    entityType: 'user',
    entityId: req.user.userId,
    clientId: isClient ? req.user.clientId || '' : '',
    metadata: { role: req.user.role || '', clientId: isClient ? req.user.clientId || '' : '' },
  }).catch(() => {});
  res.json({ id: req.user.userId, hasAvatar: false });
});

app.get('/api/clients/:clientId/avatar', async (req, res) => {
  if (!(await canAccessClient(req, req.params.clientId))) return res.status(403).json({ error: 'Client access denied' });
  const resolved = await linkedClientAvatarUser(req.params.clientId);
  if (!resolved.user) return res.status(resolved.status).json({ error: resolved.error });
  const row = await get('SELECT avatar, avatarMimeType FROM users WHERE id=?', [resolved.user.id]);
  return sendAvatarResponse(res, row);
});

app.post('/api/clients/:clientId/avatar', avatarUploadBody, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const resolved = await linkedClientAvatarUser(req.params.clientId);
  if (!resolved.user) return res.status(resolved.status).json({ error: resolved.error });
  try {
    const { buffer, normalizedMime } = validateAvatarUpload(req);
    await run('UPDATE users SET avatar=?, avatarMimeType=? WHERE id=?', [buffer, normalizedMime, resolved.user.id]);
    await recordAuditEvent(req, {
      action: 'client_avatar_admin_updated',
      entityType: 'user',
      entityId: resolved.user.id,
      clientId: req.params.clientId,
      metadata: { role: 'client', clientId: req.params.clientId, targetUserId: resolved.user.id },
    }).catch(() => {});
    res.json({ id: resolved.user.id, clientId: req.params.clientId, hasAvatar: true, mimeType: normalizedMime });
  } catch (err) {
    handleAvatarValidationError(res, err);
  }
});

app.delete('/api/clients/:clientId/avatar', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const resolved = await linkedClientAvatarUser(req.params.clientId);
  if (!resolved.user) return res.status(resolved.status).json({ error: resolved.error });
  await run("UPDATE users SET avatar=NULL, avatarMimeType='' WHERE id=?", [resolved.user.id]);
  await recordAuditEvent(req, {
    action: 'client_avatar_admin_reset',
    entityType: 'user',
    entityId: resolved.user.id,
    clientId: req.params.clientId,
    metadata: { role: 'client', clientId: req.params.clientId, targetUserId: resolved.user.id },
  }).catch(() => {});
  res.json({ id: resolved.user.id, clientId: req.params.clientId, hasAvatar: false });
});

const SIGNATURE_ASSET_MAX_BYTES = AVATAR_MAX_BYTES;
const SIGNATURE_ASSET_LABEL_MAX = 120;

function signatureAssetPublic(row = {}) {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId || null,
    assetType: row.assetType,
    label: row.label || '',
    mimeType: row.mimeType || '',
    size: Number(row.size || 0),
    isDefault: Number(row.isDefault || 0) === 1,
    createdBy: row.createdBy || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
  };
}

function signatureAssetAuditMetadata(asset = {}) {
  const metadata = signatureAssetPublic(asset);
  delete metadata.createdBy;
  delete metadata.createdAt;
  delete metadata.updatedAt;
  return metadata;
}

function canReadSignatureAsset(req, asset = {}) {
  if (!req.user || req.user.role === 'client') return false;
  if (req.user.role === 'admin') return true;
  if (asset.ownerType === 'firm' && asset.assetType === 'stamp') return true;
  if (req.user.role === 'advocate' && asset.ownerType === 'user' && asset.assetType === 'signature' && asset.ownerId === req.user.userId) return true;
  return false;
}

function canManageSignatureAsset(req, asset = {}) {
  if (!req.user || req.user.role === 'client') return false;
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'advocate' && asset.ownerType === 'user' && asset.assetType === 'signature' && asset.ownerId === req.user.userId) return true;
  return false;
}

function signatureOwnerFilter(ownerType, ownerId, assetType) {
  const params = [ownerType, assetType];
  const ownerClause = ownerId ? 'ownerId=?' : 'ownerId IS NULL';
  if (ownerId) params.push(ownerId);
  return {
    clause: `ownerType=? AND assetType=? AND ${ownerClause}`,
    params,
  };
}

async function activeSignatureAssetCount(ownerType, ownerId, assetType) {
  const filter = signatureOwnerFilter(ownerType, ownerId, assetType);
  const row = await get(`SELECT COUNT(*) count FROM signature_assets WHERE ${filter.clause} AND deletedAt IS NULL`, filter.params);
  return Number(row?.count || 0);
}

async function clearSignatureAssetDefaults(ownerType, ownerId, assetType) {
  const filter = signatureOwnerFilter(ownerType, ownerId, assetType);
  await run(`UPDATE signature_assets SET isDefault=0 WHERE ${filter.clause} AND deletedAt IS NULL`, filter.params);
}

function wantsDefault(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function normalizeSignatureAssetCreate(req) {
  const ownerType = String(req.body?.ownerType || '').trim().toLowerCase();
  const assetType = String(req.body?.assetType || '').trim().toLowerCase();
  const label = String(req.body?.label || '').trim().slice(0, SIGNATURE_ASSET_LABEL_MAX);
  if (!label) return { status: 400, error: 'label is required' };
  if (!ownerType || !assetType) return { status: 400, error: 'ownerType and assetType are required' };

  let ownerId = null;
  if (ownerType === 'firm') {
    if (assetType !== 'stamp') return { status: 400, error: 'Firm assets must be stamp images' };
    if (req.user.role !== 'admin') return { status: 403, error: 'Admin access required for firm stamp assets' };
  } else if (ownerType === 'user') {
    if (assetType !== 'signature') return { status: 400, error: 'User assets must be signature images' };
    ownerId = req.user.role === 'admin' && req.body?.ownerId ? String(req.body.ownerId).trim() : req.user.userId;
    if (!ownerId) return { status: 400, error: 'ownerId is required for user signature assets' };
    if (req.user.role !== 'admin' && ownerId !== req.user.userId) return { status: 403, error: 'Personal signature assets must belong to the current user' };
    if (!['admin', 'advocate'].includes(req.user.role)) return { status: 403, error: 'Advocate or admin access required for personal signature assets' };
    const owner = await get('SELECT id, role FROM users WHERE id=?', [ownerId]);
    if (!owner) return { status: 400, error: 'Signature owner not found' };
    if (!['admin', 'advocate'].includes(owner.role)) return { status: 400, error: 'Personal signature assets are only supported for advocates and admins' };
  } else {
    return { status: 400, error: 'ownerType must be user or firm' };
  }

  const mimeType = String(req.body?.mimeType || '').split(';')[0].trim().toLowerCase();
  if (!mimeType || !AVATAR_ALLOWED_MIME.has(mimeType)) return { status: 400, error: 'Only image/jpeg, image/png, and image/webp are supported' };
  if (!req.body?.data) return { status: 400, error: 'data is required' };
  let buffer;
  try {
    buffer = decodeAvatarBase64(req.body.data);
  } catch (err) {
    return { status: 400, error: err.message || 'Invalid image data' };
  }
  if (!buffer || buffer.length === 0) return { status: 400, error: 'Image data is empty' };
  if (buffer.length > SIGNATURE_ASSET_MAX_BYTES) return { status: 400, error: 'Image exceeds 512 KB limit' };

  return { ownerType, ownerId, assetType, label, mimeType, buffer, size: buffer.length };
}

app.get('/api/signature-assets', requireStaff, async (req, res) => {
  let rows;
  const columns = 'id,ownerType,ownerId,assetType,label,mimeType,size,isDefault,createdBy,createdAt,updatedAt';
  if (req.user.role === 'admin') {
    rows = await all(`SELECT ${columns} FROM signature_assets WHERE deletedAt IS NULL ORDER BY ownerType, assetType, isDefault DESC, createdAt DESC`);
  } else if (req.user.role === 'advocate') {
    rows = await all(`SELECT ${columns} FROM signature_assets
      WHERE deletedAt IS NULL
        AND ((ownerType='firm' AND assetType='stamp') OR (ownerType='user' AND assetType='signature' AND ownerId=?))
      ORDER BY ownerType, assetType, isDefault DESC, createdAt DESC`, [req.user.userId]);
  } else {
    rows = await all(`SELECT ${columns} FROM signature_assets
      WHERE deletedAt IS NULL AND ownerType='firm' AND assetType='stamp'
      ORDER BY isDefault DESC, createdAt DESC`);
  }
  res.json(rows.map(signatureAssetPublic));
});

app.post('/api/signature-assets', requireStaff, async (req, res) => {
  const normalized = await normalizeSignatureAssetCreate(req);
  if (normalized.error) return res.status(normalized.status || 400).json({ error: normalized.error });
  const shouldDefault = wantsDefault(req.body?.isDefault) || await activeSignatureAssetCount(normalized.ownerType, normalized.ownerId, normalized.assetType) === 0;
  const id = genId('SIG');
  const createdAt = new Date().toISOString();
  if (shouldDefault) await clearSignatureAssetDefaults(normalized.ownerType, normalized.ownerId, normalized.assetType);
  await run(`INSERT INTO signature_assets (id,ownerType,ownerId,assetType,label,mimeType,content,size,isDefault,createdBy,createdAt,updatedAt,deletedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id,
    normalized.ownerType,
    normalized.ownerId,
    normalized.assetType,
    normalized.label,
    normalized.mimeType,
    normalized.buffer,
    normalized.size,
    shouldDefault ? 1 : 0,
    req.user.userId || '',
    createdAt,
    null,
    null,
  ]);
  const asset = await get('SELECT id,ownerType,ownerId,assetType,label,mimeType,size,isDefault,createdBy,createdAt,updatedAt FROM signature_assets WHERE id=?', [id]);
  await recordAuditEvent(req, { action: 'signature_asset_created', entityType: 'signature_asset', entityId: id, metadata: signatureAssetAuditMetadata(asset) }).catch(() => {});
  res.json(signatureAssetPublic(asset));
});

app.get('/api/signature-assets/:id/content', requireStaff, async (req, res) => {
  const asset = await get('SELECT * FROM signature_assets WHERE id=? AND deletedAt IS NULL', [req.params.id]);
  if (!asset) return res.status(404).json({ error: 'Signature asset not found' });
  if (!canReadSignatureAsset(req, asset)) return res.status(403).json({ error: 'Signature asset access denied' });
  res.setHeader('Content-Type', AVATAR_ALLOWED_MIME.has(asset.mimeType) ? asset.mimeType : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.isBuffer(asset.content) ? asset.content : Buffer.from(asset.content || ''));
});

app.patch('/api/signature-assets/:id', requireStaff, async (req, res) => {
  const asset = await get('SELECT * FROM signature_assets WHERE id=? AND deletedAt IS NULL', [req.params.id]);
  if (!asset) return res.status(404).json({ error: 'Signature asset not found' });
  if (!canManageSignatureAsset(req, asset)) return res.status(403).json({ error: 'Signature asset access denied' });

  const now = new Date().toISOString();
  if (req.body?.deleted === true || req.body?.status === 'deleted') {
    await run('UPDATE signature_assets SET deletedAt=?, updatedAt=?, isDefault=0 WHERE id=?', [now, now, asset.id]);
    const deleted = { ...asset, deletedAt: now, updatedAt: now, isDefault: 0 };
    await recordAuditEvent(req, { action: 'signature_asset_deleted', entityType: 'signature_asset', entityId: asset.id, metadata: signatureAssetAuditMetadata(deleted) }).catch(() => {});
    return res.json({ ...signatureAssetPublic(deleted), deletedAt: now });
  }

  let changed = false;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'label')) {
    const label = String(req.body.label || '').trim().slice(0, SIGNATURE_ASSET_LABEL_MAX);
    if (!label) return res.status(400).json({ error: 'label is required' });
    if (label !== asset.label) {
      await run('UPDATE signature_assets SET label=?, updatedAt=? WHERE id=?', [label, now, asset.id]);
      asset.label = label;
      asset.updatedAt = now;
      changed = true;
      await recordAuditEvent(req, { action: 'signature_asset_updated', entityType: 'signature_asset', entityId: asset.id, metadata: signatureAssetAuditMetadata(asset) }).catch(() => {});
    }
  }

  if (wantsDefault(req.body?.isDefault) || wantsDefault(req.body?.default)) {
    await clearSignatureAssetDefaults(asset.ownerType, asset.ownerId || null, asset.assetType);
    await run('UPDATE signature_assets SET isDefault=1, updatedAt=? WHERE id=?', [now, asset.id]);
    asset.isDefault = 1;
    asset.updatedAt = now;
    changed = true;
    await recordAuditEvent(req, { action: 'signature_asset_default_set', entityType: 'signature_asset', entityId: asset.id, metadata: signatureAssetAuditMetadata(asset) }).catch(() => {});
  }

  if (!changed) return res.json(signatureAssetPublic(asset));
  const updated = await get('SELECT id,ownerType,ownerId,assetType,label,mimeType,size,isDefault,createdBy,createdAt,updatedAt FROM signature_assets WHERE id=?', [asset.id]);
  res.json(signatureAssetPublic(updated));
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

const conversationSummarySelect = `SELECT conv.*, c.name clientName, m.title matterTitle, m.reference,
      COALESCE(conv.status,'open') status,
      (SELECT MAX(createdAt) FROM messages msg WHERE msg.conversationId=conv.id) lastMessageAt,
      (SELECT senderRole FROM messages msg WHERE msg.conversationId=conv.id ORDER BY msg.createdAt DESC, msg.id DESC LIMIT 1) lastMessageSenderRole,
      (SELECT COUNT(*) FROM messages msg WHERE msg.conversationId=conv.id) messageCount,
      (SELECT COUNT(*) FROM messages msg WHERE msg.conversationId=conv.id AND msg.senderRole='client' AND (conv.lastStaffReadAt IS NULL OR conv.lastStaffReadAt='' OR msg.createdAt>conv.lastStaffReadAt)) staffUnreadCount,
      (SELECT COUNT(*) FROM messages msg WHERE msg.conversationId=conv.id AND msg.senderRole<>'client' AND (conv.lastClientReadAt IS NULL OR conv.lastClientReadAt='' OR msg.createdAt>conv.lastClientReadAt)) clientUnreadCount
    FROM conversations conv
    LEFT JOIN clients c ON c.id=conv.clientId
    LEFT JOIN matters m ON m.id=conv.matterId`;

function publicConversation(row, req) {
  if (!row) return row;
  const staffUnreadCount = Number(row.staffUnreadCount || 0);
  const clientUnreadCount = Number(row.clientUnreadCount || 0);
  const unreadCount = req.user.role === 'client' ? clientUnreadCount : staffUnreadCount;
  return {
    ...row,
    status: row.status || 'open',
    staffUnreadCount: req.user.role === 'client' ? undefined : staffUnreadCount,
    clientUnreadCount: req.user.role === 'client' ? clientUnreadCount : undefined,
    unreadCount,
    isUnread: unreadCount > 0,
  };
}

async function conversationSummary(conversationId, req) {
  const row = await get(`${conversationSummarySelect} WHERE conv.id=?`, [conversationId]);
  return publicConversation(row, req);
}

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
  const rows = await all(`${conversationSummarySelect}
    ${where}
    ORDER BY COALESCE(lastMessageAt, conv.createdAt) DESC`, params);
  res.json(rows.map(row => publicConversation(row, req)));
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
  const now = new Date().toISOString();
  await run('INSERT INTO conversations (id,matterId,clientId,subject,createdAt,status,statusUpdatedAt,lastStaffReadAt,lastClientReadAt) VALUES (?,?,?,?,?,?,?,?,?)', [id, matterId, clientId, subject, now, 'open', now, req.user.role === 'client' ? '' : now, req.user.role === 'client' ? now : '']);
  await logAudit(req, 'create', 'conversation', id, `Created conversation ${subject}`);
  res.json(await conversationSummary(id, req));
});

app.post('/api/conversations/:id/read', async (req, res) => {
  if (!(await canAccessConversation(req, req.params.id))) return res.status(403).json({ error: 'Conversation access denied' });
  const conversation = await get('SELECT id,matterId,clientId FROM conversations WHERE id=?', [req.params.id]);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const now = new Date().toISOString();
  if (req.user.role === 'client') {
    await run('UPDATE conversations SET lastClientReadAt=? WHERE id=?', [now, req.params.id]);
  } else {
    await run('UPDATE conversations SET lastStaffReadAt=? WHERE id=?', [now, req.params.id]);
  }
  await recordAuditEvent(req, {
    action: 'conversation_mark_read',
    entityType: 'conversation',
    entityId: req.params.id,
    matterId: conversation.matterId || '',
    clientId: conversation.clientId || req.user.clientId || '',
    metadata: { conversationId: req.params.id, side: req.user.role === 'client' ? 'client' : 'staff' },
  }).catch(() => {});
  res.json(await conversationSummary(req.params.id, req));
});

app.patch('/api/conversations/:id/status', requireStaff, async (req, res) => {
  if (!(await canAccessConversation(req, req.params.id))) return res.status(403).json({ error: 'Conversation access denied' });
  const status = String(req.body.status || '').trim().toLowerCase();
  if (!CONVERSATION_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid conversation status' });
  const conversation = await get('SELECT id,matterId,clientId,status FROM conversations WHERE id=?', [req.params.id]);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const now = new Date().toISOString();
  await run('UPDATE conversations SET status=?, statusUpdatedAt=? WHERE id=?', [status, now, req.params.id]);
  await logAudit(req, 'status', 'conversation', req.params.id, `Set conversation status to ${status}`);
  await recordAuditEvent(req, {
    action: 'conversation_status_update',
    entityType: 'conversation',
    entityId: req.params.id,
    matterId: conversation.matterId || '',
    clientId: conversation.clientId || '',
    metadata: { conversationId: req.params.id, oldStatus: conversation.status || 'open', newStatus: status },
  }).catch(() => {});
  res.json(await conversationSummary(req.params.id, req));
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  if (!(await canAccessConversation(req, req.params.id))) return res.status(403).json({ error: 'Conversation access denied' });
  const messages = await all(`SELECT msg.*, u.fullName senderName,
      (CASE WHEN u.avatar IS NOT NULL THEN 1 ELSE 0 END) senderHasAvatar
    FROM messages msg
    LEFT JOIN users u ON u.id=msg.senderId
    WHERE msg.conversationId=?
    ORDER BY msg.createdAt`, [req.params.id]);
  if (!messages.length) return res.json([]);
  const ids = messages.map(message => message.id);
  const attachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.messageId IN (${ids.map(() => '?').join(',')}) AND d.deletedAt IS NULL ORDER BY d.date DESC`, ids);
  res.json(messages.map(message => ({
    ...message,
    senderHasAvatar: Boolean(message.senderHasAvatar),
    attachments: attachments.filter(doc => doc.messageId === message.id).map(publicDocument),
  })));
});

app.get('/api/conversations/:id/messages/:messageId/avatar', async (req, res) => {
  if (!(await canAccessConversation(req, req.params.id))) return res.status(403).json({ error: 'Conversation access denied' });
  const message = await get('SELECT senderId FROM messages WHERE id=? AND conversationId=?', [req.params.messageId, req.params.id]);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const row = message.senderId ? await get('SELECT avatar, avatarMimeType FROM users WHERE id=?', [message.senderId]) : null;
  return sendAvatarResponse(res, row);
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  if (!(await canAccessConversation(req, req.params.id))) return res.status(403).json({ error: 'Conversation access denied' });
  const conversation = await get('SELECT conv.*, c.name clientName, m.title matterTitle FROM conversations conv LEFT JOIN clients c ON c.id=conv.clientId LEFT JOIN matters m ON m.id=conv.matterId WHERE conv.id=?', [req.params.id]);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const body = String(req.body.body || '').trim();
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  if (!body && !attachments.length) return res.status(400).json({ error: 'Message body or attachment is required' });
  const id = genId('MSG');
  const now = new Date().toISOString();
  await run('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)', [id, req.params.id, req.user.userId || '', req.user.role || '', body, now]);
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
    await run("UPDATE conversations SET status='open', statusUpdatedAt=?, lastClientReadAt=? WHERE id=?", [now, now, req.params.id]);
    await notifyStaff('client_message', conversation.matterId || '', 'Client sent a message', `${conversation.clientName || req.user.fullName || 'Client'}: ${body.slice(0, 160)}`, conversation.clientId || req.user.clientId || '');
    await logClientActivity({ clientId: conversation.clientId || req.user.clientId || '', matterId: conversation.matterId || '', userId: req.user.userId || '', action: 'sent_message', summary: body.slice(0, 220) || 'Sent an attachment', entityType: 'message', entityId: id });
  } else {
    await run('UPDATE conversations SET lastStaffReadAt=? WHERE id=?', [now, req.params.id]);
    await logClientActivity({ clientId: conversation.clientId || '', matterId: conversation.matterId || '', userId: req.user.userId || '', action: 'firm_sent_message', summary: body.slice(0, 220) || 'Sent an attachment', entityType: 'message', entityId: id });
  }
  await logAudit(req, 'create', 'message', id, `Added message to conversation ${conversation.subject || req.params.id}`);
  const message = await get('SELECT msg.*, u.fullName senderName FROM messages msg LEFT JOIN users u ON u.id=msg.senderId WHERE msg.id=?', [id]);
  const messageAttachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.messageId=? AND d.deletedAt IS NULL ORDER BY d.date DESC`, [id]);
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
  const noticeAttachments = await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.noticeId=? AND d.deletedAt IS NULL ORDER BY d.date DESC`, [id]);
  res.json(publicNotice(notice, noticeAttachments.map(publicDocument), req));
});
app.delete('/api/notices/:id', requireAdmin, async (req, res) => {
  const notice = await get('SELECT * FROM firm_notices WHERE id=?', [req.params.id]);
  await run("UPDATE documents SET deletedAt=? WHERE noticeId=?", [new Date().toISOString(), req.params.id]);
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
    ? await advocateDashboard(req.user.fullName || '', req)
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

  const appearanceRows = await all(`SELECT a.id, a.title, a.type appearanceType, a.date dueDate, a.time, a.meetingLink, a.attorney owner, m.id matterId, m.title matterTitle, m.reference, c.id clientId, c.name clientName
    FROM appearances a LEFT JOIN matters m ON m.id=a.matterId LEFT JOIN clients c ON c.id=m.clientId WHERE a.date<>''`);
  rows.push(...appearanceRows.map(r => ({ id: `appearance:${r.id}`, sourceId: r.id, source: 'appearance', type: 'Court Date', title: r.title || r.appearanceType || 'Court appearance', dueDate: r.dueDate, owner: r.owner || '', status: 'Open', matterId: r.matterId, matterTitle: r.matterTitle, reference: r.reference, clientId: r.clientId, clientName: r.clientName, notes: r.time ? `Time: ${r.time}` : 'Court appearance', meetingLink: r.meetingLink || '' })));

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
  await recordAuditEvent(req, { action: 'deadline_deleted', entityType: 'deadline', entityId: req.params.id, metadata: { title: deadline?.title || '', type: deadline?.type || '' } }).catch(() => {});
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

app.get('/api/clients', requireStaff, async (req, res) => {
  const rows = await all(`SELECT c.*,
    (SELECT u.id FROM users u WHERE u.role='client' AND u.clientId=c.id ORDER BY u.createdAt LIMIT 1) clientUserId,
    (SELECT CASE WHEN u.avatar IS NOT NULL THEN 1 ELSE 0 END FROM users u WHERE u.role='client' AND u.clientId=c.id ORDER BY u.createdAt LIMIT 1) hasAvatar
    FROM clients c
    ORDER BY c.name`);
  res.json(rows.map(row => ({ ...row, hasAvatar: Boolean(row.hasAvatar) })));
});
app.post('/api/clients', requireStaff, validate(createClientValidation), async (req, res) => {
  const id = genId('C');
  await run('INSERT INTO clients (id,name,type,contact,email,phone,status,joinDate,conflictCleared,retainer,remindersEnabled,preferredChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, req.body.name, req.body.type || 'Individual', req.body.contact || '', req.body.email || '', req.body.phone || '', 'Active', today(), 0, Number(req.body.retainer || 0), req.body.remindersEnabled === undefined ? 1 : (req.body.remindersEnabled ? 1 : 0), req.body.preferredChannel || 'firm_default']);
  const client = await get('SELECT * FROM clients WHERE id=?', [id]);
  await logAudit(req, 'create', 'client', id, `Created client ${client.name}`);
  await recordAuditEvent(req, { action: 'client_created', entityType: 'client', entityId: id, metadata: { name: client.name || '', type: client.type || '' } }).catch(() => {});
  res.json(client);
});
app.patch('/api/clients/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['name', 'type', 'contact', 'email', 'phone', 'status', 'conflictCleared', 'retainer', 'remindersEnabled', 'preferredChannel'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE clients SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => f === 'retainer' ? Number(req.body[f] || 0) : f === 'remindersEnabled' ? (req.body[f] ? 1 : 0) : req.body[f]), req.params.id]);
  const client = await get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  if (client) {
    await logAudit(req, 'update', 'client', req.params.id, `Updated client ${client.name}`);
    await recordAuditEvent(req, { action: 'client_updated', entityType: 'client', entityId: req.params.id, metadata: { name: client.name || '', updatedFields: updates.join(',') } }).catch(() => {});
  }
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
    await recordAuditEvent(req, { action: 'client_deleted', entityType: 'client', entityId: req.params.id, metadata: { name: client?.name || '', matterCount: matters.length } }).catch(() => {});
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
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const documentParams = [req.params.id];
  let documentWhere = 'd.matterId=? AND d.deletedAt IS NULL';
  if (req.user.role === 'client') {
    documentWhere += ` AND ${clientDocumentVisibilitySql('d')}`;
    documentParams.push(req.user.clientId || '');
  }
  const [tasks, timeEntries, documents, notes, invoices, appearances, checklistItems] = await Promise.all([
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM tasks WHERE matterId=? ORDER BY dueDate', [req.params.id]),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM time_entries WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE ${documentWhere} ORDER BY d.date DESC`, documentParams),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id]),
    all('SELECT * FROM invoices WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT * FROM appearances WHERE matterId=? ORDER BY date', [req.params.id]),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM matter_checklist_items WHERE matterId=? ORDER BY position ASC, createdAt ASC', [req.params.id])
  ]);
  await attachInvoiceSummaries(invoices);
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    matter.totalBilled = null;
    matter.fixedFee = null;
    for (const te of timeEntries) te.rate = null;
    for (const inv of invoices) maskInvoiceBilling(inv);
  }
  const payload = { ...matter, tasks, timeEntries, documents: documents.map(publicDocument), notes, invoices, appearances };
  if (req.user.role !== 'client') payload.checklistItems = checklistItems;
  res.json(payload);
});
app.get('/api/matters/:id/suggestions', async (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Staff access required' });
  const matter = await get('SELECT m.*, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }

  const todayDate = today();
  const [taskStats, timeStats, docStats, noteStats, invoiceStats, nextAppearance] = await Promise.all([
    get('SELECT COUNT(*) total, SUM(CASE WHEN completed=0 AND dueDate < ? THEN 1 ELSE 0 END) overdue FROM tasks WHERE matterId=?', [todayDate, req.params.id]),
    get('SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN billed=0 AND billable=1 THEN hours*rate ELSE 0 END),0) unbilled FROM time_entries WHERE matterId=?', [req.params.id]),
    get('SELECT COUNT(*) total FROM documents WHERE matterId=? AND deletedAt IS NULL', [req.params.id]),
    get('SELECT COUNT(*) total FROM case_notes WHERE matterId=?', [req.params.id]),
    get(`SELECT COUNT(*) total, SUM(CASE WHEN status='Outstanding' THEN 1 ELSE 0 END) outstanding FROM invoices WHERE matterId=?`, [req.params.id]),
    get('SELECT * FROM appearances WHERE matterId=? AND date>=? ORDER BY date LIMIT 1', [req.params.id, todayDate]),
  ]);

  const suggestions = [];
  const taskTotal = Number(taskStats?.total || 0);
  const overdueTasks = Number(taskStats?.overdue || 0);
  const timeTotal = Number(timeStats?.total || 0);
  const docTotal = Number(docStats?.total || 0);
  const noteTotal = Number(noteStats?.total || 0);

  const billingVisible = req.user.role !== 'advocate' || (await isBillingVisibleFor(req));

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
  if (billingVisible) {
    const unbilled = Number(timeStats?.unbilled || 0);
    const invoiceTotal = Number(invoiceStats?.total || 0);
    const outstandingInvoices = Number(invoiceStats?.outstanding || 0);
    if (unbilled > 0) suggestions.push(`There is ${unbilled.toLocaleString('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 })} in unbilled time. Consider generating an invoice.`);
    if ((matter.billingType || '').toLowerCase() === 'fixed' && Number(matter.fixedFee || 0) > 0 && invoiceTotal === 0) suggestions.push('This is a fixed-fee matter with no invoice yet. Generate the fixed-fee invoice when engagement is confirmed.');
    if (Number(matter.retainerBalance || 0) > 0 && Number(matter.retainerBalance || 0) < 50000) suggestions.push('Retainer balance is running low. Consider requesting a top-up before more billable work is done.');
    if ((matter.stage || '').toLowerCase() === 'closed' && outstandingInvoices > 0) suggestions.push('This matter is closed but still has an outstanding invoice. Follow up with the client or mark payment when received.');
  }
  if (noteTotal === 0 && taskTotal > 0) suggestions.push('There are tasks on this file but no case notes. Add a short status note to preserve matter context.');
  if (!suggestions.length) suggestions.push('This matter looks up to date. No urgent action is needed right now.');

  res.json(suggestions);
});
app.get('/api/matters/:id/work-metadata-links', requireStaff, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const rows = await all(`
    SELECT
      wml.id AS linkId,
      wml.sourceType,
      wml.sourceId AS sourceRecordId,
      CASE WHEN wml.sourceType='email' THEN wem.subject WHEN wml.sourceType='calendar' THEN wce.subject END AS subject,
      CASE WHEN wml.sourceType='email' THEN wem.sender END AS sender,
      CASE WHEN wml.sourceType='calendar' THEN wce.organizer END AS organizer,
      CASE WHEN wml.sourceType='email' THEN wem.receivedAt END AS receivedAt,
      CASE WHEN wml.sourceType='calendar' THEN wce.startTime END AS startTime,
      CASE WHEN wml.sourceType='email' THEN wem.hasAttachments END AS hasAttachments,
      CASE WHEN wml.sourceType='calendar' THEN wce.meetingLink END AS meetingLink,
      ca.email AS accountEmail,
      ca.provider AS accountProvider,
      wml.confirmedBy,
      wml.confirmedAt
    FROM work_metadata_matter_links wml
    LEFT JOIN work_email_messages wem ON wml.sourceType='email' AND wml.sourceId=wem.id
    LEFT JOIN work_calendar_events wce ON wml.sourceType='calendar' AND wml.sourceId=wce.id
    LEFT JOIN connected_accounts ca ON ca.id=COALESCE(wem.connectedAccountId,wce.connectedAccountId)
    WHERE wml.matterId=? AND wml.status='confirmed'
    ORDER BY wml.confirmedAt DESC
  `, [req.params.id]);
  res.json(rows);
});
app.post('/api/matters', requireAdvocateOrAdmin, validate(createMatterValidation), async (req, res) => {
  const id = genId('M');
  const reference = req.body.reference || `LEX-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
  await run(`INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,paralegal,openDate,description,court,judge,caseNo,opposingCounsel,billingRate,retainerBalance,totalBilled,priority,solDate,billingType,fixedFee,remindersEnabled,courtRemindersEnabled,invoiceRemindersEnabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, reference, req.body.clientId, req.body.title, req.body.practiceArea || '', req.body.stage || 'Intake', req.body.assignedTo || '', req.body.paralegal || '', req.body.openDate || today(), req.body.description || '', req.body.court || '', req.body.judge || '', req.body.caseNo || '', req.body.opposingCounsel || '', Number(req.body.billingRate || 0), Number(req.body.retainerBalance || 0), 0, req.body.priority || 'Medium', req.body.solDate || '', req.body.billingType || 'hourly', Number(req.body.fixedFee || 0), req.body.remindersEnabled || 'firm_default', req.body.courtRemindersEnabled || 'firm_default', req.body.invoiceRemindersEnabled || 'firm_default']);
  const matter = await get('SELECT * FROM matters WHERE id=?', [id]);
  await logAudit(req, 'create', 'matter', id, `Created matter ${matter.title} (${matter.reference})`);
  await recordAuditEvent(req, { action: 'matter_created', entityType: 'matter', entityId: id, clientId: matter.clientId || '', metadata: { title: matter.title || '', reference: matter.reference || '', stage: matter.stage || '', practiceArea: matter.practiceArea || '' } }).catch(() => {});
  res.json(matter);
});
app.patch('/api/matters/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const fields = ['reference','clientId','title','practiceArea','stage','assignedTo','paralegal','openDate','description','court','judge','caseNo','opposingCounsel','priority','billingRate','billingType','fixedFee','retainerBalance','totalBilled','solDate','remindersEnabled','courtRemindersEnabled','invoiceRemindersEnabled'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE matters SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => ['billingRate','fixedFee','retainerBalance','totalBilled'].includes(f) ? Number(req.body[f] || 0) : req.body[f]), req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
  if (matter) {
    await logAudit(req, 'update', 'matter', req.params.id, `Updated matter ${matter.title}`);
    await recordAuditEvent(req, { action: 'matter_updated', entityType: 'matter', entityId: req.params.id, clientId: matter.clientId || '', metadata: { title: matter.title || '', updatedFields: updates.join(','), stage: matter.stage || '' } }).catch(() => {});
  }
  matter ? res.json(matter) : res.status(404).json({ error: 'Matter not found' });
});
app.patch('/api/matters/:id/status', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  await run('UPDATE matters SET stage=? WHERE id=?', [req.body.stage || 'Closed', req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
  if (matter) {
    await logAudit(req, 'archive', 'matter', req.params.id, `Set matter ${matter.title} stage to ${matter.stage}`);
    await recordAuditEvent(req, { action: 'matter_archived', entityType: 'matter', entityId: req.params.id, clientId: matter.clientId || '', metadata: { title: matter.title || '', stage: matter.stage || '' } }).catch(() => {});
  }
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
  await run('DELETE FROM matter_checklist_items WHERE matterId=?', [matterId]);
  await run('DELETE FROM matters WHERE id=?', [matterId]);
}
app.delete('/api/matters/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const matter = await get('SELECT id,title,reference FROM matters WHERE id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  await run('BEGIN TRANSACTION');
  try {
    await deleteMatterCascade(req.params.id);
    await run('COMMIT');
    await logAudit(req, 'delete', 'matter', req.params.id, `Deleted matter ${matter.title} (${matter.reference || matter.id})`);
    await recordAuditEvent(req, { action: 'matter_deleted', entityType: 'matter', entityId: req.params.id, metadata: { title: matter.title || '', reference: matter.reference || '' } }).catch(() => {});
    res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/matters/:id/reassign', authenticate, requireAdmin, async (req, res) => {
  const { assignedTo } = req.body;
  if (typeof assignedTo !== 'string' || !assignedTo.trim()) return res.status(400).json({ error: 'assignedTo is required' });
  const trimmed = assignedTo.trim();
  if (trimmed.length > 120) return res.status(400).json({ error: 'assignedTo must not exceed 120 characters' });
  const matter = await get('SELECT id, title, reference, assignedTo FROM matters WHERE id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  if (matter.assignedTo === trimmed) return res.status(400).json({ error: 'Matter is already assigned to this advocate' });
  const target = await get('SELECT id, fullName, role, isActive FROM users WHERE fullName=?', [trimmed]);
  if (!target) return res.status(400).json({ error: 'Assigned user does not exist' });
  if (target.role !== 'advocate') return res.status(400).json({ error: 'Assigned user is not an advocate' });
  if (target.isActive !== 1) return res.status(400).json({ error: 'Assigned advocate is not active' });
  const oldAssignedTo = matter.assignedTo || '';
  await run('UPDATE matters SET assignedTo=? WHERE id=?', [trimmed, req.params.id]);
  const updated = await get('SELECT m.*, c.name clientName, (SELECT MIN(date) FROM appearances a WHERE a.matterId=m.id AND a.date>=?) nextCourtDate FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [new Date().toISOString().slice(0, 10), req.params.id]);
  await logAudit(req, 'reassign', 'matter', req.params.id, `Reassigned matter ${matter.title} from "${oldAssignedTo}" to "${trimmed}"`);
  await recordAuditEvent(req, { action: 'matter_reassigned', entityType: 'matter', entityId: req.params.id, metadata: { oldAssignedTo, newAssignedTo: trimmed, matterTitle: matter.title || '', matterReference: matter.reference || '' } }).catch(() => {});
  res.json(updated);
});

app.get('/api/checklist-templates', requireStaff, async (req, res) => {
  const templates = await all('SELECT * FROM checklist_templates WHERE active=1 ORDER BY name COLLATE NOCASE ASC, createdAt ASC');
  res.json(await attachChecklistTemplateItems(templates));
});
app.post('/api/checklist-templates', requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Template name is required' });
  if (name.length > 160) return res.status(400).json({ error: 'Template name must not exceed 160 characters' });
  const parsed = parseChecklistTemplateItems(req.body?.items, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const id = genId('CTPL');
  const createdAt = new Date().toISOString();
  const description = typeof req.body?.description === 'string' ? req.body.description : '';
  const practiceArea = typeof req.body?.practiceArea === 'string' ? req.body.practiceArea : '';
  await run('BEGIN TRANSACTION');
  try {
    await run('INSERT INTO checklist_templates (id,name,description,practiceArea,active,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)', [id, name, description, practiceArea, 1, actorLabel(req), createdAt, createdAt]);
    for (const item of parsed.items) {
      await run('INSERT INTO checklist_template_items (id,templateId,title,notes,position,createdAt) VALUES (?,?,?,?,?,?)', [genId('CTI'), id, item.title, item.notes, item.position, createdAt]);
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  }
  const template = await getChecklistTemplateWithItems(id);
  await recordAuditEvent(req, { action: 'checklist_template_created', entityType: 'checklist_template', entityId: id, metadata: { templateId: id, name, itemCount: parsed.items.length, active: 1 } }).catch(() => {});
  res.json(template);
});
app.patch('/api/checklist-templates/:id', requireAdmin, async (req, res) => {
  const existing = await get('SELECT * FROM checklist_templates WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  const updates = [];
  const params = [];
  const updatedFields = [];
  if (req.body?.name !== undefined) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Template name must not be empty' });
    if (name.length > 160) return res.status(400).json({ error: 'Template name must not exceed 160 characters' });
    updates.push('name=?');
    params.push(name);
    updatedFields.push('name');
  }
  if (req.body?.description !== undefined) {
    updates.push('description=?');
    params.push(typeof req.body.description === 'string' ? req.body.description : '');
    updatedFields.push('description');
  }
  if (req.body?.practiceArea !== undefined) {
    updates.push('practiceArea=?');
    params.push(typeof req.body.practiceArea === 'string' ? req.body.practiceArea : '');
    updatedFields.push('practiceArea');
  }
  if (req.body?.active !== undefined) {
    const active = normalizeTemplateActive(req.body.active);
    if (active === null) return res.status(400).json({ error: 'Invalid template active status' });
    updates.push('active=?');
    params.push(active);
    updatedFields.push('active');
  }
  const parsed = parseChecklistTemplateItems(req.body?.items, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (parsed.items) updatedFields.push('items');
  if (!updates.length && !parsed.items) return res.status(400).json({ error: 'No supported fields supplied' });
  const updatedAt = new Date().toISOString();
  updates.push('updatedAt=?');
  params.push(updatedAt);
  params.push(req.params.id);
  await run('BEGIN TRANSACTION');
  try {
    await run(`UPDATE checklist_templates SET ${updates.join(',')} WHERE id=?`, params);
    if (parsed.items) {
      await run('DELETE FROM checklist_template_items WHERE templateId=?', [req.params.id]);
      for (const item of parsed.items) {
        await run('INSERT INTO checklist_template_items (id,templateId,title,notes,position,createdAt) VALUES (?,?,?,?,?,?)', [genId('CTI'), req.params.id, item.title, item.notes, item.position, updatedAt]);
      }
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  }
  const template = await getChecklistTemplateWithItems(req.params.id);
  await recordAuditEvent(req, { action: 'checklist_template_updated', entityType: 'checklist_template', entityId: req.params.id, metadata: { templateId: req.params.id, name: template?.name || '', updatedFields: updatedFields.join(','), itemCount: template?.items?.length || 0, active: Number(template?.active || 0) } }).catch(() => {});
  res.json(template);
});
app.delete('/api/checklist-templates/:id', requireAdmin, async (req, res) => {
  const existing = await get('SELECT * FROM checklist_templates WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  const updatedAt = new Date().toISOString();
  await run('UPDATE checklist_templates SET active=0, updatedAt=? WHERE id=?', [updatedAt, req.params.id]);
  await recordAuditEvent(req, { action: 'checklist_template_deleted', entityType: 'checklist_template', entityId: req.params.id, metadata: { templateId: req.params.id, name: existing.name || '', active: 0 } }).catch(() => {});
  res.json({ id: req.params.id, deleted: true, active: 0 });
});
app.post('/api/matters/:matterId/checklist-template-applications', requireAdvocateOrAdmin, async (req, res) => {
  const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId.trim() : '';
  if (!templateId) return res.status(400).json({ error: 'Template id is required' });
  if (!(await canAccessMatter(req, req.params.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_checklist_template_access', entityType: 'matter', entityId: req.params.matterId, matterId: req.params.matterId, metadata: { reason: 'insufficient permissions', route: 'template_apply', templateId } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const template = await getChecklistTemplateWithItems(templateId, true);
  if (!template) return res.status(404).json({ error: 'Active template not found' });
  if (!template.items.length) return res.status(400).json({ error: 'Template has no items' });
  const last = await get('SELECT COALESCE(MAX(position), -1) maxPos FROM matter_checklist_items WHERE matterId=?', [req.params.matterId]);
  const startPosition = Number(last?.maxPos ?? -1) + 1;
  const createdAt = new Date().toISOString();
  const createdBy = actorLabel(req);
  const createdIds = [];
  await run('BEGIN TRANSACTION');
  try {
    for (let index = 0; index < template.items.length; index += 1) {
      const item = template.items[index];
      const id = genId('CHK');
      createdIds.push(id);
      await run(
        'INSERT INTO matter_checklist_items (id,matterId,title,completed,position,notes,dueDate,assignee,createdBy,createdAt,updatedAt,completedAt,completedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, req.params.matterId, item.title, 0, startPosition + index, item.notes || '', '', '', createdBy, createdAt, createdAt, '', ''],
      );
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  }
  const placeholders = createdIds.map(() => '?').join(',');
  const createdItems = await all(`SELECT * FROM matter_checklist_items WHERE id IN (${placeholders}) ORDER BY position ASC, createdAt ASC`, createdIds);
  await recordAuditEvent(req, { action: 'matter_checklist_template_applied', entityType: 'checklist_template', entityId: templateId, matterId: req.params.matterId, metadata: { templateId, matterId: req.params.matterId, itemCount: createdItems.length } }).catch(() => {});
  res.json(createdItems);
});

function normalizeDocumentTemplateOptionalText(value) {
  return typeof value === 'string' ? value : '';
}

app.get('/api/document-templates', requireStaff, async (req, res) => {
  const includeInactive = req.query?.includeInactive === '1' || req.query?.includeInactive === 'true';
  const sql = includeInactive
    ? 'SELECT * FROM document_templates ORDER BY practiceArea COLLATE NOCASE ASC, category COLLATE NOCASE ASC, name COLLATE NOCASE ASC, createdAt ASC'
    : 'SELECT * FROM document_templates WHERE active=1 ORDER BY practiceArea COLLATE NOCASE ASC, category COLLATE NOCASE ASC, name COLLATE NOCASE ASC, createdAt ASC';
  const templates = await all(sql);
  res.json(templates);
});
app.get('/api/document-templates/:id', requireStaff, async (req, res) => {
  const template = await get('SELECT * FROM document_templates WHERE id=? AND active=1', [req.params.id]);
  if (!template) return res.status(404).json({ error: 'Document template not found' });
  res.json(template);
});
app.post('/api/matters/:matterId/document-templates/:templateId/preview', requireStaff, async (req, res) => {
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.matterId]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  if (!(await canAccessMatter(req, req.params.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_document_template_preview', entityType: 'matter', entityId: req.params.matterId, matterId: req.params.matterId, metadata: { reason: 'insufficient permissions', templateId: req.params.templateId } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const template = await get('SELECT * FROM document_templates WHERE id=? AND active=1', [req.params.templateId]);
  if (!template) return res.status(404).json({ error: 'Active document template not found' });
  const [client, firm] = await Promise.all([
    get('SELECT * FROM clients WHERE id=?', [matter.clientId || '']),
    get('SELECT * FROM firm_settings WHERE id=?', ['default']),
  ]);
  const context = buildTemplateMergeContext({
    firm: firm || {},
    matter,
    client: client || {},
    user: req.user || {},
    today: today(),
  });
  const merged = mergeTemplateMarkup(template.bodyMarkup || '', context);
  res.json({
    templateId: template.id,
    matterId: matter.id,
    preview: merged.preview,
    tokens: merged.tokens,
    unresolvedTokens: merged.unresolvedTokens,
  });
});
app.post('/api/matters/:matterId/document-templates/:templateId/generate', requireStaff, async (req, res) => {
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.matterId]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });

  const canGenerate = req.user?.role === 'admin' || (req.user?.role === 'advocate' && await canAccessMatter(req, req.params.matterId));
  if (!canGenerate) {
    await recordAuditEvent(req, {
      action: 'forbidden_document_generation',
      entityType: 'matter',
      entityId: req.params.matterId,
      matterId: req.params.matterId,
      clientId: matter.clientId || '',
      metadata: {
        reason: 'insufficient permissions',
        route: 'document_template_generate',
        matterId: req.params.matterId,
        templateId: req.params.templateId,
      },
    }).catch(() => {});
    return res.status(403).json({ error: 'Document generation access denied' });
  }

  const template = await get('SELECT * FROM document_templates WHERE id=? AND active=1', [req.params.templateId]);
  if (!template) return res.status(404).json({ error: 'Active document template not found' });

  const [client, firm] = await Promise.all([
    get('SELECT * FROM clients WHERE id=?', [matter.clientId || '']),
    get('SELECT * FROM firm_settings WHERE id=?', ['default']),
  ]);
  const generatedAt = new Date().toISOString();
  const context = buildTemplateMergeContext({
    firm: firm || {},
    matter,
    client: client || {},
    user: req.user || {},
    today: today(),
  });
  const merged = mergeTemplateMarkup(template.bodyMarkup || '', context);
  const content = Buffer.from(merged.preview, 'utf8');
  const documentId = genId('DOC');
  const generatedDate = today();
  const displayName = cleanDocumentName(`${template.name || 'Generated draft'} draft ${generatedDate}.txt`);
  const name = cleanDocumentName(displayName);
  const actor = actorLabel(req);
  const size = `${Math.max(1, Math.round(content.length / 1024))} KB`;

  await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy,templateId,templateName,generatedBy,generatedAt,version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    documentId,
    req.params.matterId,
    name,
    displayName,
    'Text',
    'text/plain',
    generatedDate,
    size,
    content,
    'generated',
    null,
    null,
    null,
    0,
    actor,
    template.id,
    template.name || '',
    actor,
    generatedAt,
    1,
  ]);

  const doc = await get(`SELECT d.id,d.matterId,d.name,d.displayName,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,d.messageId,d.noticeId,d.clientVisible,d.uploadedBy,d.templateId,d.templateName,d.generatedBy,d.generatedAt,d.version,f.name folderName
    FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentId]);
  await logAudit(req, 'generate', 'document', documentId, `Generated draft document ${doc.displayName || doc.name}`);
  await recordAuditEvent(req, {
    action: 'document_generated',
    entityType: 'document',
    entityId: documentId,
    matterId: req.params.matterId,
    clientId: matter.clientId || '',
    metadata: {
      matterId: req.params.matterId,
      templateId: template.id,
      templateName: template.name || '',
      documentId,
      outputFormat: 'text/plain',
      bodyLength: merged.preview.length,
      contentLength: content.length,
      unresolvedTokenCount: merged.unresolvedTokens.length,
      clientVisible: 0,
      source: 'generated',
    },
  }).catch(() => {});

  res.json({
    ...publicDocument(doc),
    unresolvedTokens: merged.unresolvedTokens,
  });
});
app.post('/api/document-templates', requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Document template name is required' });
  if (name.length > 160) return res.status(400).json({ error: 'Document template name must not exceed 160 characters' });
  const description = normalizeDocumentTemplateOptionalText(req.body?.description);
  const practiceArea = normalizeDocumentTemplateOptionalText(req.body?.practiceArea);
  const category = normalizeDocumentTemplateOptionalText(req.body?.category);
  const bodyMarkup = normalizeDocumentTemplateOptionalText(req.body?.bodyMarkup);
  const id = genId('DTPL');
  const createdAt = new Date().toISOString();
  await run('INSERT INTO document_templates (id,name,description,practiceArea,category,bodyMarkup,active,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, name, description, practiceArea, category, bodyMarkup, 1, actorLabel(req), createdAt, createdAt]);
  const template = await get('SELECT * FROM document_templates WHERE id=?', [id]);
  await logAudit(req, 'create', 'document_template', id, `Created document template ${name}`);
  await recordAuditEvent(req, { action: 'document_template_created', entityType: 'document_template', entityId: id, metadata: { templateId: id, name, practiceArea, category, hasBody: Boolean(bodyMarkup), bodyLength: bodyMarkup.length, active: 1 } }).catch(() => {});
  res.json(template);
});
app.patch('/api/document-templates/:id', requireAdmin, async (req, res) => {
  const existing = await get('SELECT * FROM document_templates WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Document template not found' });
  const updates = [];
  const params = [];
  const updatedFields = [];
  if (req.body?.name !== undefined) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Document template name must not be empty' });
    if (name.length > 160) return res.status(400).json({ error: 'Document template name must not exceed 160 characters' });
    updates.push('name=?');
    params.push(name);
    updatedFields.push('name');
  }
  if (req.body?.description !== undefined) {
    updates.push('description=?');
    params.push(normalizeDocumentTemplateOptionalText(req.body.description));
    updatedFields.push('description');
  }
  if (req.body?.practiceArea !== undefined) {
    updates.push('practiceArea=?');
    params.push(normalizeDocumentTemplateOptionalText(req.body.practiceArea));
    updatedFields.push('practiceArea');
  }
  if (req.body?.category !== undefined) {
    updates.push('category=?');
    params.push(normalizeDocumentTemplateOptionalText(req.body.category));
    updatedFields.push('category');
  }
  if (req.body?.bodyMarkup !== undefined) {
    updates.push('bodyMarkup=?');
    params.push(normalizeDocumentTemplateOptionalText(req.body.bodyMarkup));
    updatedFields.push('bodyMarkup');
  }
  if (req.body?.active !== undefined) {
    const active = normalizeTemplateActive(req.body.active);
    if (active === null) return res.status(400).json({ error: 'Invalid document template active status' });
    updates.push('active=?');
    params.push(active);
    updatedFields.push('active');
  }
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  const updatedAt = new Date().toISOString();
  updates.push('updatedAt=?');
  params.push(updatedAt);
  params.push(req.params.id);
  await run(`UPDATE document_templates SET ${updates.join(',')} WHERE id=?`, params);
  const template = await get('SELECT * FROM document_templates WHERE id=?', [req.params.id]);
  await logAudit(req, 'update', 'document_template', req.params.id, `Updated document template ${template?.name || req.params.id}`);
  await recordAuditEvent(req, { action: 'document_template_updated', entityType: 'document_template', entityId: req.params.id, metadata: { templateId: req.params.id, name: template?.name || '', updatedFields: updatedFields.join(','), active: Number(template?.active || 0), bodyLength: String(template?.bodyMarkup || '').length } }).catch(() => {});
  res.json(template);
});
app.delete('/api/document-templates/:id', requireAdmin, async (req, res) => {
  const existing = await get('SELECT * FROM document_templates WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Document template not found' });
  const updatedAt = new Date().toISOString();
  await run('UPDATE document_templates SET active=0, updatedAt=? WHERE id=?', [updatedAt, req.params.id]);
  await logAudit(req, 'delete', 'document_template', req.params.id, `Soft-deleted document template ${existing.name || req.params.id}`);
  await recordAuditEvent(req, { action: 'document_template_deleted', entityType: 'document_template', entityId: req.params.id, metadata: { templateId: req.params.id, name: existing.name || '', active: 0 } }).catch(() => {});
  res.json({ id: req.params.id, deleted: true, active: 0 });
});

app.get('/api/matters/:id/checklist-items', requireStaff, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_checklist_item_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'checklist_list' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const items = await all('SELECT * FROM matter_checklist_items WHERE matterId=? ORDER BY position ASC, createdAt ASC', [req.params.id]);
  res.json(items);
});
app.post('/api/matters/:id/checklist-items', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_checklist_item_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'checklist_create' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (title.length > 240) return res.status(400).json({ error: 'Title must not exceed 240 characters' });
  const notes = typeof req.body?.notes === 'string' ? req.body.notes : '';
  const dueDate = normalizeChecklistOptionalText(req.body?.dueDate);
  const assignee = normalizeChecklistOptionalText(req.body?.assignee);
  let position = Number.isFinite(Number(req.body?.position)) ? Number(req.body.position) : null;
  if (position === null || position < 0) {
    const last = await get('SELECT COALESCE(MAX(position), -1) maxPos FROM matter_checklist_items WHERE matterId=?', [req.params.id]);
    position = Number(last?.maxPos ?? -1) + 1;
  }
  const id = genId('CHK');
  const createdAt = new Date().toISOString();
  await run('INSERT INTO matter_checklist_items (id,matterId,title,completed,position,notes,dueDate,assignee,createdBy,createdAt,updatedAt,completedAt,completedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, req.params.id, title, 0, position, notes, dueDate, assignee, req.user.fullName || req.user.email || req.user.userId || '', createdAt, createdAt, '', '']);
  const item = await get('SELECT * FROM matter_checklist_items WHERE id=?', [id]);
  await recordAuditEvent(req, { action: 'matter_checklist_item_created', entityType: 'matter_checklist_item', entityId: id, matterId: req.params.id, metadata: { matterId: req.params.id, title, position } }).catch(() => {});
  res.json(item);
});
app.patch('/api/matters/:matterId/checklist-items/:id', requireStaff, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_checklist_item_access', entityType: 'matter', entityId: req.params.matterId, metadata: { reason: 'insufficient permissions', route: 'checklist_update' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const existing = await get('SELECT * FROM matter_checklist_items WHERE id=? AND matterId=?', [req.params.id, req.params.matterId]);
  if (!existing) return res.status(404).json({ error: 'Checklist item not found' });
  const role = req.user?.role;
  const wantsCompletionChange = req.body?.completed !== undefined;
  const contentFields = ['title', 'notes', 'position', 'dueDate', 'assignee'];
  const wantsContentChange = contentFields.some(field => req.body?.[field] !== undefined);
  if (role === 'assistant' && wantsContentChange) {
    await recordAuditEvent(req, { action: 'forbidden_matter_checklist_item_access', entityType: 'matter_checklist_item', entityId: req.params.id, matterId: req.params.matterId, metadata: { reason: 'assistant cannot modify content', route: 'checklist_update' } }).catch(() => {});
    return res.status(403).json({ error: 'Assistants may only toggle completion' });
  }
  if (!wantsContentChange && !wantsCompletionChange) return res.status(400).json({ error: 'No supported fields supplied' });
  const updates = [];
  const params = [];
  if (wantsContentChange) {
    if (req.body.title !== undefined) {
      const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title) return res.status(400).json({ error: 'Title must not be empty' });
      if (title.length > 240) return res.status(400).json({ error: 'Title must not exceed 240 characters' });
      updates.push('title=?');
      params.push(title);
    }
    if (req.body.notes !== undefined) {
      updates.push('notes=?');
      params.push(typeof req.body.notes === 'string' ? req.body.notes : '');
    }
    if (req.body.position !== undefined) {
      const pos = Number(req.body.position);
      if (!Number.isFinite(pos) || pos < 0) return res.status(400).json({ error: 'Invalid position' });
      updates.push('position=?');
      params.push(pos);
    }
    if (req.body.dueDate !== undefined) {
      updates.push('dueDate=?');
      params.push(normalizeChecklistOptionalText(req.body.dueDate));
    }
    if (req.body.assignee !== undefined) {
      updates.push('assignee=?');
      params.push(normalizeChecklistOptionalText(req.body.assignee));
    }
  }
  let completionTransition = null;
  if (wantsCompletionChange) {
    const nextCompleted = req.body.completed ? 1 : 0;
    if (Number(existing.completed) !== nextCompleted) {
      completionTransition = nextCompleted === 1 ? 'completed' : 'reopened';
      updates.push('completed=?');
      params.push(nextCompleted);
      if (nextCompleted === 1) {
        updates.push('completedAt=?', 'completedBy=?');
        params.push(new Date().toISOString(), req.user.fullName || req.user.email || req.user.userId || '');
      } else {
        updates.push('completedAt=?', 'completedBy=?');
        params.push('', '');
      }
    }
  }
  const updatedAt = new Date().toISOString();
  updates.push('updatedAt=?');
  params.push(updatedAt);
  params.push(req.params.id);
  await run(`UPDATE matter_checklist_items SET ${updates.join(',')} WHERE id=?`, params);
  const item = await get('SELECT * FROM matter_checklist_items WHERE id=?', [req.params.id]);
  if (completionTransition === 'completed') {
    await recordAuditEvent(req, { action: 'matter_checklist_item_completed', entityType: 'matter_checklist_item', entityId: req.params.id, matterId: req.params.matterId, metadata: { matterId: req.params.matterId, title: item?.title || '' } }).catch(() => {});
  } else if (completionTransition === 'reopened') {
    await recordAuditEvent(req, { action: 'matter_checklist_item_reopened', entityType: 'matter_checklist_item', entityId: req.params.id, matterId: req.params.matterId, metadata: { matterId: req.params.matterId, title: item?.title || '' } }).catch(() => {});
  }
  if (wantsContentChange) {
    const updatedFields = contentFields.filter(f => req.body[f] !== undefined);
    await recordAuditEvent(req, { action: 'matter_checklist_item_updated', entityType: 'matter_checklist_item', entityId: req.params.id, matterId: req.params.matterId, metadata: { matterId: req.params.matterId, updatedFields: updatedFields.join(',') } }).catch(() => {});
  }
  res.json(item);
});
app.delete('/api/matters/:matterId/checklist-items/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_checklist_item_access', entityType: 'matter', entityId: req.params.matterId, metadata: { reason: 'insufficient permissions', route: 'checklist_delete' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const existing = await get('SELECT id, title FROM matter_checklist_items WHERE id=? AND matterId=?', [req.params.id, req.params.matterId]);
  if (!existing) return res.status(404).json({ error: 'Checklist item not found' });
  await run('DELETE FROM matter_checklist_items WHERE id=?', [req.params.id]);
  await recordAuditEvent(req, { action: 'matter_checklist_item_deleted', entityType: 'matter_checklist_item', entityId: req.params.id, matterId: req.params.matterId, metadata: { matterId: req.params.matterId, title: existing.title || '' } }).catch(() => {});
  res.json({ id: req.params.id, deleted: true });
});

app.get('/api/tasks', requireStaff, async (req, res) => {
  let query = 'SELECT * FROM tasks';
  const params = [];
  if (req.user?.role === 'advocate') {
    query += ' WHERE assignee=? OR id IN (SELECT t.id FROM tasks t JOIN matters m ON m.id=t.matterId WHERE m.assignedTo=?)';
    params.push(req.user.fullName || '', req.user.fullName || '');
  }
  query += ' ORDER BY dueDate';
  res.json(await all(query, params));
});
app.post('/api/tasks', requireStaff, async (req, res) => { const id = genId('T'); await run('INSERT INTO tasks (id,matterId,title,completed,assignee,dueDate,auto_generated) VALUES (?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.title, req.body.completed ? 1 : 0, req.body.assignee || '', req.body.dueDate || '', 0]); const task = await get('SELECT * FROM tasks WHERE id=?', [id]); await logAudit(req, 'create', 'task', id, `Created task ${task.title}`); res.json(task); });
app.patch('/api/tasks/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessTask(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_task_access', entityType: 'task', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Task access denied' });
  }
  await run('UPDATE tasks SET completed=COALESCE(?,completed), title=COALESCE(?,title), assignee=COALESCE(?,assignee), dueDate=COALESCE(?,dueDate) WHERE id=?', [req.body.completed === undefined ? null : (req.body.completed ? 1 : 0), req.body.title ?? null, req.body.assignee ?? null, req.body.dueDate ?? null, req.params.id]);
  const task = await get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (task) await logAudit(req, req.body.completed !== undefined ? 'complete' : 'update', 'task', req.params.id, `${req.body.completed !== undefined ? (task.completed ? 'Completed' : 'Reopened') : 'Updated'} task ${task.title}`);
  res.json(task);
});
app.delete('/api/tasks/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessTask(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_task_access', entityType: 'task', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Task access denied' });
  }
  const task = await get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  await run('DELETE FROM tasks WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'task', req.params.id, `Deleted task ${task?.title || req.params.id}`);
  await recordAuditEvent(req, { action: 'task_deleted', entityType: 'task', entityId: req.params.id, metadata: { title: task?.title || '' } }).catch(() => {});
  res.json({ id: req.params.id, deleted: true });
});

app.get('/api/time-entries', requireStaff, async (req, res) => {
  let query = 'SELECT * FROM time_entries';
  const params = [];
  if (req.user?.role === 'advocate') {
    query += ' WHERE attorney=? OR matterId IN (SELECT id FROM matters WHERE assignedTo=?)';
    params.push(req.user.fullName || '', req.user.fullName || '');
  }
  query += ' ORDER BY date DESC';
  const entries = await all(query, params);
  if (req.user?.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    for (const e of entries) e.rate = null;
  }
  res.json(entries);
});
app.get('/api/time-entries/:id', requireStaff, async (req, res) => {
  if (!(await canAccessTimeEntry(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_time_entry_access', entityType: 'time_entry', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Time entry access denied' });
  }
  const entry = await get('SELECT * FROM time_entries WHERE id=?', [req.params.id]);
  if (entry && req.user?.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    entry.rate = null;
  }
  entry ? res.json(entry) : res.status(404).json({ error: 'Time entry not found' });
});

app.post('/api/time-entries', requireStaff, async (req, res) => {
  const matterId = req.body.matterId;
  if (!(await canAccessMatter(req, matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId || '', metadata: { reason: 'insufficient permissions', route: 'time_entry_create' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const taskId = req.body.taskId || '';
  if (taskId) {
    const task = await get('SELECT id,matterId,title FROM tasks WHERE id=?', [taskId]);
    if (!task) return res.status(400).json({ error: 'Task not found' });
    if (task.matterId !== req.body.matterId) return res.status(400).json({ error: 'Task does not belong to this matter' });
  }
  const billable = normalizeBillable(req.body.billable, 1);
  if (billable === null) return res.status(400).json({ error: 'Invalid billable value' });
  const id = genId('TIME');
  await run('INSERT INTO time_entries (id,matterId,taskId,attorney,date,hours,activity,description,rate,billed,billable) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, taskId, req.body.attorney || req.user.fullName || '', req.body.date || today(), Number(req.body.hours || 0), req.body.activity || '', req.body.description || '', Number(req.body.rate || 0), req.body.billed ? 1 : 0, billable]);
  const entry = await get('SELECT * FROM time_entries WHERE id=?', [id]);
  await logAudit(req, 'create', 'time_entry', id, `Logged ${entry.hours} hour(s) for matter ${entry.matterId}${entry.taskId ? ` task ${entry.taskId}` : ''}`);
  res.json(entry);
});
app.patch('/api/time-entries/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessTimeEntry(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_time_entry_access', entityType: 'time_entry', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Time entry access denied' });
  }
  const fields = ['matterId','taskId','attorney','date','hours','activity','description','rate','billed','billable'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  const billable = updates.includes('billable') ? normalizeBillable(req.body.billable) : undefined;
  if (updates.includes('billable') && billable === null) return res.status(400).json({ error: 'Invalid billable value' });
  const oldEntry = updates.includes('billable') ? await get('SELECT billable FROM time_entries WHERE id=?', [req.params.id]) : null;
  if (req.body.taskId) {
    const matterId = req.body.matterId || (await get('SELECT matterId FROM time_entries WHERE id=?', [req.params.id]))?.matterId;
    const task = await get('SELECT id,matterId FROM tasks WHERE id=?', [req.body.taskId]);
    if (!task) return res.status(400).json({ error: 'Task not found' });
    if (task.matterId !== matterId) return res.status(400).json({ error: 'Task does not belong to this matter' });
  }
  await run(`UPDATE time_entries SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => ['hours','rate'].includes(f) ? Number(req.body[f] || 0) : f === 'billed' ? (req.body[f] ? 1 : 0) : f === 'billable' ? billable : req.body[f]), req.params.id]);
  const entry = await get('SELECT * FROM time_entries WHERE id=?', [req.params.id]);
  const billableChanged = entry && oldEntry && updates.includes('billable') && Number(oldEntry.billable) !== Number(entry.billable);
  if (entry) await logAudit(req, req.body.billed !== undefined ? 'bill_toggle' : billableChanged ? 'billable_toggle' : 'update', 'time_entry', req.params.id, `${req.body.billed !== undefined ? (entry.billed ? 'Marked billed' : 'Marked unbilled') : billableChanged ? `Marked ${entry.billable ? 'billable' : 'non-billable'}` : 'Updated'} time entry for matter ${entry.matterId}`);
  entry ? res.json(entry) : res.status(404).json({ error: 'Time entry not found' });
});
app.delete('/api/time-entries/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessTimeEntry(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_time_entry_access', entityType: 'time_entry', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Time entry access denied' });
  }
  const entry = await get('SELECT * FROM time_entries WHERE id=?', [req.params.id]);
  await run('DELETE FROM time_entries WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'time_entry', req.params.id, `Deleted time entry for matter ${entry?.matterId || ''}`);
  res.json({ id: req.params.id, deleted: true });
});

app.get('/api/appearances', requireStaff, async (req, res) => {
  let query = 'SELECT * FROM appearances';
  const params = [];
  if (req.user?.role === 'advocate') {
    query += ' WHERE attorney=? OR id IN (SELECT a.id FROM appearances a JOIN matters m ON m.id=a.matterId WHERE m.assignedTo=?)';
    params.push(req.user.fullName || '', req.user.fullName || '');
  }
  query += ' ORDER BY date';
  res.json(await all(query, params));
});
app.get('/api/appearances/upcoming', requireStaff, async (req, res) => res.json(await all('SELECT * FROM appearances WHERE date>=? ORDER BY date LIMIT 20', [today()])));
app.get('/api/appearances/:id', requireStaff, async (req, res) => {
  if (!(await canAccessAppearance(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const appearance = await get('SELECT * FROM appearances WHERE id=?', [req.params.id]);
  appearance ? res.json(appearance) : res.status(404).json({ error: 'Appearance not found' });
});

app.post('/api/appearances', requireAdvocateOrAdmin, async (req, res) => { const id = genId('EV'); await run('INSERT INTO appearances (id,matterId,title,date,time,type,location,meetingLink,attorney,prepNote) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.title, req.body.date, req.body.time || '9:00 AM', req.body.type || 'Hearing', req.body.location || '', req.body.meetingLink || '', req.body.attorney || '', req.body.prepNote || '']); const event = await get('SELECT * FROM appearances WHERE id=?', [id]); await logAudit(req, 'create', 'appearance', id, `Scheduled ${event.type || 'appearance'} ${event.title || ''} on ${event.date}`); res.json(event); });
app.patch('/api/appearances/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessAppearance(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const fields = ['matterId','title','date','time','type','location','meetingLink','attorney','prepNote'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE appearances SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => req.body[f]), req.params.id]);
  const event = await get('SELECT * FROM appearances WHERE id=?', [req.params.id]);
  if (event) await logAudit(req, 'update', 'appearance', req.params.id, `Updated appearance ${event.title || event.type || req.params.id}`);
  event ? res.json(event) : res.status(404).json({ error: 'Appearance not found' });
});
app.delete('/api/appearances/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessAppearance(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const event = await get('SELECT * FROM appearances WHERE id=?', [req.params.id]);
  await run('DELETE FROM appearances WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'appearance', req.params.id, `Deleted appearance ${event?.title || event?.type || req.params.id}`);
  await recordAuditEvent(req, { action: 'appearance_deleted', entityType: 'appearance', entityId: req.params.id, metadata: { title: event?.title || '', type: event?.type || '' } }).catch(() => {});
  res.json({ id: req.params.id, deleted: true });
});

// Document request endpoints
app.post('/api/document-requests', requireStaff, async (req, res) => {
  const { matterId, title, description } = req.body;
  if (!matterId) return res.status(400).json({ error: 'matterId is required' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [matterId]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  if (!(await canAccessMatter(req, matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_request_create' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const id = genId('DR');
  const now = new Date().toISOString();
  await run('INSERT INTO document_requests (id,matterId,clientId,staffUserId,title,description,status,createdAt) VALUES (?,?,?,?,?,?,?,?)',
    [id, matterId, matter.clientId, req.user.userId || '', title.trim(), (description || '').trim(), 'pending', now]);
  const request = await get('SELECT * FROM document_requests WHERE id=?', [id]);
  await recordAuditEvent(req, { action: 'document_requested', entityType: 'document_request', entityId: id, matterId, clientId: matter.clientId, metadata: { title: title.trim(), matterId } }).catch(() => {});
  res.json(request);
});

app.get('/api/document-requests', requireStaff, async (req, res) => {
  const { matterId } = req.query;
  if (matterId) {
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_request_list' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }
    const rows = await all(`SELECT dr.*, d.name responseDocumentName, d.displayName responseDocumentDisplayName, d.mimeType responseDocumentMimeType, d.size responseDocumentSize, d.date responseDocumentDate
      FROM document_requests dr LEFT JOIN documents d ON d.id=dr.responseDocumentId AND d.matterId=dr.matterId AND d.deletedAt IS NULL WHERE dr.matterId=? ORDER BY dr.createdAt DESC`, [matterId]);
    return res.json(rows);
  }
  if (req.user.role === 'advocate') {
    const rows = await all(`SELECT dr.*, d.name responseDocumentName, d.displayName responseDocumentDisplayName, d.mimeType responseDocumentMimeType, d.size responseDocumentSize, d.date responseDocumentDate
      FROM document_requests dr LEFT JOIN documents d ON d.id=dr.responseDocumentId AND d.matterId=dr.matterId AND d.deletedAt IS NULL JOIN matters m ON m.id=dr.matterId WHERE m.assignedTo=? ORDER BY dr.createdAt DESC`, [req.user.fullName || '']);
    return res.json(rows);
  }
  const rows = await all(`SELECT dr.*, d.name responseDocumentName, d.displayName responseDocumentDisplayName, d.mimeType responseDocumentMimeType, d.size responseDocumentSize, d.date responseDocumentDate
    FROM document_requests dr LEFT JOIN documents d ON d.id=dr.responseDocumentId AND d.matterId=dr.matterId AND d.deletedAt IS NULL ORDER BY dr.createdAt DESC`);
  res.json(rows);
});

app.get('/api/client/document-requests', async (req, res) => {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Client access required' });
  const clientId = req.user.clientId || '';
  const rows = await all(`SELECT dr.*, m.title matterTitle, d.name responseDocumentName, d.displayName responseDocumentDisplayName, d.mimeType responseDocumentMimeType, d.size responseDocumentSize, d.date responseDocumentDate
    FROM document_requests dr LEFT JOIN matters m ON m.id=dr.matterId LEFT JOIN documents d ON d.id=dr.responseDocumentId AND d.matterId=dr.matterId AND d.deletedAt IS NULL WHERE dr.clientId=? AND dr.status IN ('pending','fulfilled') ORDER BY dr.createdAt DESC`, [clientId]);
  res.json(rows);
});

app.post('/api/document-requests/:id/respond', async (req, res) => {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Client access required' });
  const request = await get('SELECT * FROM document_requests WHERE id=?', [req.params.id]);
  if (!request) return res.status(404).json({ error: 'Document request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Document request is not pending' });
  if (request.clientId !== req.user.clientId) {
    await recordAuditEvent(req, { action: 'forbidden_document_request_access', entityType: 'document_request', entityId: req.params.id, metadata: { reason: 'client mismatch' } }).catch(() => {});
    return res.status(403).json({ error: 'Access denied' });
  }
  const { name, mimeType, data } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name and data are required' });
  const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const imageAllowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (![...allowed, ...imageAllowed].includes(mimeType)) return res.status(400).json({ error: 'Only PDF, Word and image documents are supported' });
  const docId = genId('DOC');
  const buffer = Buffer.from(String(data).split(',').pop(), 'base64');
  const cleanName = cleanDocumentName(name);
  const cleanDisplayName = cleanDocumentName(name);
  const type = imageAllowed.includes(mimeType) ? 'Image' : mimeType.includes('pdf') ? 'PDF' : 'Word';
  const folder = await clientUploadsFolder(request.matterId, req.user.userId || '');
  await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [docId, request.matterId, cleanName, cleanDisplayName, type, mimeType, today(), `${Math.max(1, Math.round(buffer.length / 1024))} KB`, buffer, 'client', folder.id, null, null, 0, req.user.userId || '']);
  const now = new Date().toISOString();
  await run('UPDATE document_requests SET status=?, respondedAt=?, responseDocumentId=? WHERE id=?', ['fulfilled', now, docId, req.params.id]);
  const updated = await get('SELECT * FROM document_requests WHERE id=?', [req.params.id]);
  await recordAuditEvent(req, { action: 'document_request_responded', entityType: 'document_request', entityId: req.params.id, matterId: request.matterId, clientId: req.user.clientId || '', metadata: { requestTitle: request.title, responseDocumentId: docId } }).catch(() => {});
  await recordAuditEvent(req, { action: 'document_uploaded', entityType: 'document', entityId: docId, matterId: request.matterId, clientId: req.user.clientId || '', metadata: { filename: cleanName, context: 'document_request_response', route: 'document_request_response' } }).catch(() => {});
  await logAudit(req, 'upload', 'document', docId, `Uploaded document ${cleanName} in response to request ${request.title}`);
  const matter = await get('SELECT m.title, m.reference, c.id clientId, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [request.matterId]);
  await notifyStaff('client_document', request.matterId, 'Client responded to document request', `${matter?.clientName || req.user.fullName || 'Client'} uploaded ${cleanName} for "${request.title}" on ${matter?.title || 'a matter'}.`, matter?.clientId || req.user.clientId || '');
  await logClientActivity({ clientId: req.user.clientId || '', matterId: request.matterId, userId: req.user.userId || '', action: 'responded_document_request', summary: `Uploaded ${cleanName} for "${request.title}"`, entityType: 'document', entityId: docId });
  const responseDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=? AND d.matterId=? AND d.deletedAt IS NULL`, [docId, request.matterId]);
  res.json({ ...updated, responseDocument: responseDoc ? publicDocument(responseDoc) : null });
});

app.patch('/api/document-requests/:id', requireStaff, async (req, res) => {
  const request = await get('SELECT * FROM document_requests WHERE id=?', [req.params.id]);
  if (!request) return res.status(404).json({ error: 'Document request not found' });
  if (!(await canAccessDocumentRequest(req, request))) {
    await recordAuditEvent(req, { action: 'forbidden_document_request_access', entityType: 'document_request', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Access denied' });
  }
  if (req.body.status === 'cancelled') {
    if (request.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    const now = new Date().toISOString();
    await run('UPDATE document_requests SET status=?, cancelledAt=?, cancelledBy=? WHERE id=?', ['cancelled', now, req.user.userId || '', req.params.id]);
    const updated = await get('SELECT * FROM document_requests WHERE id=?', [req.params.id]);
    await recordAuditEvent(req, { action: 'document_request_cancelled', entityType: 'document_request', entityId: req.params.id, matterId: request.matterId, clientId: request.clientId, metadata: { title: request.title } }).catch(() => {});
    return res.json(updated);
  }
  return res.status(400).json({ error: 'Only status=cancelled is supported' });
});

app.get('/api/matters/:id/folders', async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) return res.status(403).json({ error: 'Matter access denied' });
  res.json(await matterFolders(req.params.id, req));
});
app.post('/api/matters/:id/folders', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
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
  const folder = await get('SELECT * FROM folders WHERE id=?', [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (!(await canAccessMatter(req, folder.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: folder.matterId, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const existing = await get('SELECT id FROM folders WHERE matterId=? AND lower(name)=lower(?) AND id<>?', [folder.matterId, name, req.params.id]);
  if (existing) return res.status(400).json({ error: 'Folder already exists for this matter' });
  await run('UPDATE folders SET name=? WHERE id=?', [name, req.params.id]);
  await logAudit(req, 'update', 'folder', req.params.id, `Renamed folder ${folder.name} to ${name}`);
  res.json(await get('SELECT * FROM folders WHERE id=?', [req.params.id]));
});
app.delete('/api/folders/:id', requireAdvocateOrAdmin, async (req, res) => {
  const folder = await get('SELECT * FROM folders WHERE id=?', [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (!(await canAccessMatter(req, folder.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: folder.matterId, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
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
  let where = 'd.matterId=? AND d.deletedAt IS NULL';
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
  } else if (req.user.role === 'advocate') {
    if (!(await canAccessMatter(req, req.params.id))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }
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
  const uploadContext = documentAuditContext(doc);
  await recordAuditEvent(req, {
    action: 'document_uploaded',
    entityType: 'document',
    entityId: id,
    matterId: req.params.id,
    clientId: await documentAuditClientId(doc, req),
    metadata: safeDocumentMetadata(doc, uploadContext, 'document_upload', {
      clientVisible: Boolean(clientVisible),
    }),
  }).catch(() => {});
  if (req.user.role === 'client') {
    const matter = await get('SELECT m.title, m.reference, c.id clientId, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
    await notifyStaff('client_document', req.params.id, 'Client uploaded a document', `${matter?.clientName || req.user.fullName || 'Client'} uploaded ${doc.name} for ${matter?.title || 'a matter'}.`, matter?.clientId || req.user.clientId || '');
    await logClientActivity({ clientId: matter?.clientId || req.user.clientId || '', matterId: req.params.id, userId: req.user.userId || '', action: 'uploaded_document', summary: `Uploaded ${doc.displayName || doc.name}`, entityType: 'document', entityId: id });
  }
  res.json(publicDocument(doc));
});
app.get('/api/documents/:id/download', async (req, res) => {
  const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!(await canAccessDocument(req, doc))) {
    await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: req.params.id, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_download' } }).catch(() => {});
    return res.status(403).json({ error: 'Document access denied' });
  }
  if (req.user.role === 'client') {
    await logClientActivity({ clientId: req.user.clientId || '', matterId: doc.matterId || '', userId: req.user.userId || '', action: 'downloaded_document', summary: `Downloaded ${doc.displayName || doc.name || req.params.id}`, entityType: 'document', entityId: req.params.id });
  }
  const downloadContext = documentAuditContext(doc);
  const downloadClientId = await documentAuditClientId(doc, req);
  const downloadMetadata = safeDocumentMetadata(doc, downloadContext, 'document_download', {
    matterId: doc.matterId || '',
  });
  await recordAuditEvent(req, { action: 'document_accessed', entityType: 'document', entityId: req.params.id, matterId: doc.matterId || '', clientId: downloadClientId, metadata: { documentId: req.params.id, matterId: doc.matterId || '', mimeType: doc.mimeType || '' } }).catch(() => {});
  await recordAuditEvent(req, { action: 'document_downloaded', entityType: 'document', entityId: req.params.id, matterId: doc.matterId || '', clientId: downloadClientId, metadata: downloadMetadata }).catch(() => {});
  res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${cleanDocumentName(doc.displayName || doc.name)}"`);
  res.send(doc.content);
});

app.post('/api/document-tools/merge-pdfs', requireStaff, async (req, res) => {
  try {
    const documentIds = Array.isArray(req.body?.documentIds)
      ? req.body.documentIds.map(id => String(id || '').trim()).filter(Boolean)
      : null;

    if (!documentIds) return res.status(400).json({ error: 'documentIds must be an array' });
    if (documentIds.length < 2) return res.status(400).json({ error: 'Select at least 2 PDF documents to merge' });
    if (documentIds.length > MAX_MERGE_PDF_COUNT) return res.status(400).json({ error: `Select no more than ${MAX_MERGE_PDF_COUNT} PDF documents` });
    if (new Set(documentIds).size !== documentIds.length) return res.status(400).json({ error: 'Duplicate document IDs are not allowed' });

    const outputFilename = cleanPdfDownloadName(req.body?.filename);
    const sourceDocs = [];
    let matterId = '';
    let combinedInputBytes = 0;

    for (const documentId of documentIds) {
      const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
        await recordAuditEvent(req, {
          action: 'forbidden_document_access',
          entityType: 'document',
          entityId: documentId,
          matterId: doc.matterId || '',
          clientId: await documentAuditClientId(doc, req),
          metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_merge_pdfs' },
        }).catch(() => {});
        return res.status(403).json({ error: 'Document access denied' });
      }
      if (!matterId) matterId = doc.matterId;
      if (doc.matterId !== matterId) return res.status(400).json({ error: 'All PDFs must belong to the same matter' });
      if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be merged' });

      const content = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
      combinedInputBytes += content.length;
      if (combinedInputBytes > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Selected PDFs exceed the 20 MB merge limit' });
      sourceDocs.push({ ...doc, content });
    }

    const mergedPdf = await PDFLibDocument.create();
    try {
      for (const doc of sourceDocs) {
        const sourcePdf = await PDFLibDocument.load(doc.content, { ignoreEncryption: false });
        const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach(page => mergedPdf.addPage(page));
      }
    } catch {
      return res.status(400).json({ error: 'One or more selected PDFs could not be read' });
    }

    const mergedBytes = await mergedPdf.save();
    const mergedBuffer = Buffer.from(mergedBytes);
    const clientId = await documentAuditClientId(sourceDocs[0], req);

    await recordAuditEvent(req, {
      action: 'document_tool_merge_pdf_downloaded',
      entityType: 'document_tool',
      entityId: matterId,
      matterId,
      clientId,
      metadata: {
        route: 'document_tool_merge_pdfs',
        sourceDocumentIds: documentIds,
        documentCount: sourceDocs.length,
        matterId,
        combinedInputBytes,
        outputBytes: mergedBuffer.length,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(mergedBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to merge PDFs' });
  }
});
app.post('/api/document-tools/merge-pdfs/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentIds: rawDocumentIds, filename: rawFilename, folderId: rawFolderId } = req.body || {};

    if (!matterId) return res.status(400).json({ error: 'matterId is required' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_merge_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const documentIds = Array.isArray(rawDocumentIds)
      ? rawDocumentIds.map(id => String(id || '').trim()).filter(Boolean)
      : null;

    if (!documentIds) return res.status(400).json({ error: 'documentIds must be an array' });
    if (documentIds.length < 2) return res.status(400).json({ error: 'Select at least 2 PDF documents to merge' });
    if (documentIds.length > MAX_MERGE_PDF_COUNT) return res.status(400).json({ error: `Select no more than ${MAX_MERGE_PDF_COUNT} PDF documents` });
    if (new Set(documentIds).size !== documentIds.length) return res.status(400).json({ error: 'Duplicate document IDs are not allowed' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'merged-document.pdf');
    const sourceDocs = [];
    let combinedInputBytes = 0;

    for (const documentId of documentIds) {
      const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
        await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_merge_pdf_save' } }).catch(() => {});
        return res.status(403).json({ error: 'Document access denied' });
      }
      if (doc.matterId !== matterId) return res.status(400).json({ error: 'All PDFs must belong to the target matter' });
      if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be merged' });

      const content = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
      combinedInputBytes += content.length;
      if (combinedInputBytes > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Selected PDFs exceed the 20 MB merge limit' });
      sourceDocs.push({ ...doc, content });
    }

    const mergedPdf = await PDFLibDocument.create();
    try {
      for (const doc of sourceDocs) {
        const sourcePdf = await PDFLibDocument.load(doc.content, { ignoreEncryption: false });
        const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach(page => mergedPdf.addPage(page));
      }
    } catch {
      return res.status(400).json({ error: 'One or more selected PDFs could not be read' });
    }

    const mergedBytes = await mergedPdf.save();
    const mergedBuffer = Buffer.from(mergedBytes);

    if (mergedBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Merged PDF exceeds the 50 MB output limit' });

    const documentId = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(mergedBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentId,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      mergedBuffer,
      'document_tool',
      rawFolderId || null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const doc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentId]);

    await recordAuditEvent(req, {
      action: 'document_tool_merge_pdf_saved',
      entityType: 'document_tool',
      entityId: documentId,
      matterId,
      clientId: await documentAuditClientId(doc, req),
      metadata: {
        sourceDocumentIds: documentIds,
        sourceCount: sourceDocs.length,
        targetMatterId: matterId,
        outputDocumentId: documentId,
        combinedInputBytes,
        outputBytes: mergedBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(doc));
  } catch {
    res.status(500).json({ error: 'Unable to save merged PDF' });
  }
});

app.post('/api/document-tools/rotate-pdf', requireStaff, async (req, res) => {
  try {
    const { documentId, degrees: rawDegrees, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_rotate_pdf' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be rotated' });

    const degreesValue = Number(rawDegrees);
    if (![90, 180, 270].includes(degreesValue)) return res.status(400).json({ error: 'degrees must be 90, 180, or 270' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'rotated-document.pdf');
    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const pages = sourcePdf.getPages();
    for (const page of pages) {
      page.setRotation(degrees(degreesValue));
    }

    const rotatedBytes = await sourcePdf.save();
    const rotatedBuffer = Buffer.from(rotatedBytes);
    const clientId = await documentAuditClientId(doc, req);

    await recordAuditEvent(req, {
      action: 'document_tool_rotate_pdf_downloaded',
      entityType: 'document_tool',
      entityId: documentId,
      matterId: doc.matterId || '',
      clientId,
      metadata: {
        sourceDocumentId: documentId,
        sourceMatterId: doc.matterId || '',
        degrees: degreesValue,
        inputBytes: inputContent.length,
        outputBytes: rotatedBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(rotatedBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to rotate PDF' });
  }
});

app.post('/api/document-tools/rotate-pdf/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentId, degrees: rawDegrees, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!matterId) return res.status(400).json({ error: 'matterId is required' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_rotate_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_rotate_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be rotated' });
    if (doc.matterId !== matterId) return res.status(400).json({ error: 'Document must belong to the target matter' });

    const degreesValue = Number(rawDegrees);
    if (![90, 180, 270].includes(degreesValue)) return res.status(400).json({ error: 'degrees must be 90, 180, or 270' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const pages = sourcePdf.getPages();
    for (const page of pages) {
      page.setRotation(degrees(degreesValue));
    }

    const rotatedBytes = await sourcePdf.save();
    const rotatedBuffer = Buffer.from(rotatedBytes);

    if (rotatedBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Rotated PDF exceeds the 50 MB output limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(rawFilename || 'rotated-document.pdf');
    const size = `${Math.max(1, Math.round(rotatedBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      rotatedBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_rotate_pdf_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentId: documentId,
        targetMatterId: matterId,
        outputDocumentId: documentIdNew,
        degrees: degreesValue,
        inputBytes: inputContent.length,
        outputBytes: rotatedBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save rotated PDF' });
  }
});

app.post('/api/document-tools/extract-pdf-pages', requireStaff, async (req, res) => {
  try {
    const { documentId, ranges: rawRanges, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (typeof rawRanges !== 'string' || !rawRanges.trim()) return res.status(400).json({ error: 'ranges is required' });

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_extract_pdf_pages' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be extracted' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'extracted-pages.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const parsed = parsePageRanges(rawRanges, sourcePdf.getPageCount());
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let outputBuffer;
    try {
      const outputPdf = await PDFLibDocument.create();
      const copiedPages = await outputPdf.copyPages(sourcePdf, parsed.indices);
      copiedPages.forEach(page => outputPdf.addPage(page));
      outputBuffer = Buffer.from(await outputPdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not extract the requested pages' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Extracted PDF exceeds the 50 MB output limit' });

    const clientId = await documentAuditClientId(doc, req);
    await recordAuditEvent(req, {
      action: 'document_tool_extract_pdf_pages_downloaded',
      entityType: 'document_tool',
      entityId: documentId,
      matterId: doc.matterId || '',
      clientId,
      metadata: {
        route: 'document_tool_extract_pdf_pages',
        sourceDocumentId: documentId,
        sourceMatterId: doc.matterId || '',
        ranges: rawRanges.trim(),
        extractedPageCount: parsed.indices.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to extract PDF pages' });
  }
});

app.post('/api/document-tools/extract-pdf-pages/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentId, ranges: rawRanges, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!matterId) return res.status(400).json({ error: 'matterId is required' });
    if (typeof rawRanges !== 'string' || !rawRanges.trim()) return res.status(400).json({ error: 'ranges is required' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_extract_pdf_pages_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_extract_pdf_pages_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be extracted' });
    if (doc.matterId !== matterId) return res.status(400).json({ error: 'Document must belong to the target matter' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'extracted-pages.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const parsed = parsePageRanges(rawRanges, sourcePdf.getPageCount());
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let outputBuffer;
    try {
      const outputPdf = await PDFLibDocument.create();
      const copiedPages = await outputPdf.copyPages(sourcePdf, parsed.indices);
      copiedPages.forEach(page => outputPdf.addPage(page));
      outputBuffer = Buffer.from(await outputPdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not extract the requested pages' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Extracted PDF exceeds the 50 MB output limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_extract_pdf_pages_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentId: documentId,
        targetMatterId: matterId,
        outputDocumentId: documentIdNew,
        ranges: rawRanges.trim(),
        extractedPageCount: parsed.indices.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save extracted PDF' });
  }
});

// PRODUCT-27D: Split / reorder pages — copy the pages of one matter PDF into a
// new PDF in a caller-supplied order. Pages may be reordered, selected, or
// repeated. The source document is never modified. Mirrors the extract tool.
app.post('/api/document-tools/split-pdf', requireStaff, async (req, res) => {
  try {
    const { documentId, order: rawOrder, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (typeof rawOrder !== 'string' || !rawOrder.trim()) return res.status(400).json({ error: 'order is required' });

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_split_pdf' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be reordered' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'reordered-pages.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const parsed = parsePageOrder(rawOrder, sourcePdf.getPageCount());
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let outputBuffer;
    try {
      const outputPdf = await PDFLibDocument.create();
      const copiedPages = await outputPdf.copyPages(sourcePdf, parsed.indices);
      copiedPages.forEach(page => outputPdf.addPage(page));
      outputBuffer = Buffer.from(await outputPdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not reorder the requested pages' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Reordered PDF exceeds the 50 MB output limit' });

    const clientId = await documentAuditClientId(doc, req);
    await recordAuditEvent(req, {
      action: 'document_tool_split_pdf_downloaded',
      entityType: 'document_tool',
      entityId: documentId,
      matterId: doc.matterId || '',
      clientId,
      metadata: {
        route: 'document_tool_split_pdf',
        sourceDocumentId: documentId,
        sourceMatterId: doc.matterId || '',
        order: rawOrder.trim(),
        pageCount: sourcePdf.getPageCount(),
        outputPageCount: parsed.indices.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to reorder PDF pages' });
  }
});

app.post('/api/document-tools/split-pdf/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentId, order: rawOrder, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!matterId) return res.status(400).json({ error: 'matterId is required' });
    if (typeof rawOrder !== 'string' || !rawOrder.trim()) return res.status(400).json({ error: 'order is required' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_split_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_split_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be reordered' });
    if (doc.matterId !== matterId) return res.status(400).json({ error: 'Document must belong to the target matter' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'reordered-pages.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const parsed = parsePageOrder(rawOrder, sourcePdf.getPageCount());
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let outputBuffer;
    try {
      const outputPdf = await PDFLibDocument.create();
      const copiedPages = await outputPdf.copyPages(sourcePdf, parsed.indices);
      copiedPages.forEach(page => outputPdf.addPage(page));
      outputBuffer = Buffer.from(await outputPdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not reorder the requested pages' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Reordered PDF exceeds the 50 MB output limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_split_pdf_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentId: documentId,
        targetMatterId: matterId,
        outputDocumentId: documentIdNew,
        order: rawOrder.trim(),
        pageCount: sourcePdf.getPageCount(),
        outputPageCount: parsed.indices.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save reordered PDF' });
  }
});

// PRODUCT-27E: Images to PDF — combine existing matter image documents (PNG/JPEG)
// into a new PDF, one image per page, centred and scaled to fit within margins.
// v1 uses existing uploaded image documents only (no browser upload). WebP is not
// supported by pdf-lib's embedders and is rejected with a clear message. Original
// image documents are never modified.
const MAX_IMAGES_TO_PDF_COUNT = 10;
const IMAGES_TO_PDF_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg']);
const IMAGES_TO_PDF_MARGIN = 36; // 0.5 inch in PDF points
const IMAGES_TO_PDF_PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792] }; // portrait points

function normalizeImagesPageSize(raw) {
  const key = String(raw || 'A4').trim().toUpperCase();
  if (key === 'A4') return 'A4';
  if (key === 'LETTER') return 'Letter';
  return null;
}

async function buildImagesPdf(images, sizeKey) {
  const [pageWidth, pageHeight] = IMAGES_TO_PDF_PAGE_SIZES[sizeKey];
  const maxWidth = pageWidth - IMAGES_TO_PDF_MARGIN * 2;
  const maxHeight = pageHeight - IMAGES_TO_PDF_MARGIN * 2;
  const pdf = await PDFLibDocument.create();
  for (const image of images) {
    const embedded = image.mime === 'image/png'
      ? await pdf.embedPng(image.content)
      : await pdf.embedJpg(image.content);
    const ratio = Math.min(maxWidth / embedded.width, maxHeight / embedded.height);
    const drawWidth = embedded.width * ratio;
    const drawHeight = embedded.height * ratio;
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }
  return Buffer.from(await pdf.save());
}

app.post('/api/document-tools/images-to-pdf', requireStaff, async (req, res) => {
  try {
    const documentIds = Array.isArray(req.body?.documentIds)
      ? req.body.documentIds.map(id => String(id || '').trim()).filter(Boolean)
      : null;

    if (!documentIds) return res.status(400).json({ error: 'documentIds must be an array' });
    if (documentIds.length < 1) return res.status(400).json({ error: 'Select at least 1 image document' });
    if (documentIds.length > MAX_IMAGES_TO_PDF_COUNT) return res.status(400).json({ error: `Select no more than ${MAX_IMAGES_TO_PDF_COUNT} images` });
    if (new Set(documentIds).size !== documentIds.length) return res.status(400).json({ error: 'Duplicate document IDs are not allowed' });

    const sizeKey = normalizeImagesPageSize(req.body?.pageSize);
    if (!sizeKey) return res.status(400).json({ error: 'pageSize must be A4 or Letter' });

    const outputFilename = cleanPdfDownloadName(req.body?.filename || 'images.pdf');
    const images = [];
    let matterId = '';
    let combinedInputBytes = 0;

    for (const documentId of documentIds) {
      const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
        await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_images_to_pdf' } }).catch(() => {});
        return res.status(403).json({ error: 'Document access denied' });
      }
      if (!matterId) matterId = doc.matterId;
      if (doc.matterId !== matterId) return res.status(400).json({ error: 'All images must belong to the same matter' });
      const mime = String(doc.mimeType || '').toLowerCase();
      if (mime === 'image/webp') return res.status(400).json({ error: 'WebP images are not supported for PDF conversion. Use PNG or JPEG.' });
      if (!IMAGES_TO_PDF_ALLOWED_MIME.has(mime)) return res.status(400).json({ error: 'Only PNG and JPEG image documents can be converted' });

      const content = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
      combinedInputBytes += content.length;
      if (combinedInputBytes > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Selected images exceed the 20 MB input limit' });
      images.push({ ...doc, content, mime });
    }

    let outputBuffer;
    try {
      outputBuffer = await buildImagesPdf(images, sizeKey);
    } catch {
      return res.status(400).json({ error: 'One or more images could not be embedded into the PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Generated PDF exceeds the 50 MB output limit' });

    const clientId = await documentAuditClientId(images[0], req);
    await recordAuditEvent(req, {
      action: 'document_tool_images_to_pdf_downloaded',
      entityType: 'document_tool',
      entityId: matterId,
      matterId,
      clientId,
      metadata: {
        route: 'document_tool_images_to_pdf',
        sourceDocumentIds: documentIds,
        sourceMatterId: matterId,
        imageCount: images.length,
        pageSize: sizeKey,
        inputBytes: combinedInputBytes,
        outputBytes: outputBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to convert images to PDF' });
  }
});

app.post('/api/document-tools/images-to-pdf/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, filename: rawFilename } = req.body || {};

    if (!matterId) return res.status(400).json({ error: 'matterId is required' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_images_to_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const documentIds = Array.isArray(req.body?.documentIds)
      ? req.body.documentIds.map(id => String(id || '').trim()).filter(Boolean)
      : null;

    if (!documentIds) return res.status(400).json({ error: 'documentIds must be an array' });
    if (documentIds.length < 1) return res.status(400).json({ error: 'Select at least 1 image document' });
    if (documentIds.length > MAX_IMAGES_TO_PDF_COUNT) return res.status(400).json({ error: `Select no more than ${MAX_IMAGES_TO_PDF_COUNT} images` });
    if (new Set(documentIds).size !== documentIds.length) return res.status(400).json({ error: 'Duplicate document IDs are not allowed' });

    const sizeKey = normalizeImagesPageSize(req.body?.pageSize);
    if (!sizeKey) return res.status(400).json({ error: 'pageSize must be A4 or Letter' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'images.pdf');
    const images = [];
    let combinedInputBytes = 0;

    for (const documentId of documentIds) {
      const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
        await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_images_to_pdf_save' } }).catch(() => {});
        return res.status(403).json({ error: 'Document access denied' });
      }
      if (doc.matterId !== matterId) return res.status(400).json({ error: 'All images must belong to the target matter' });
      const mime = String(doc.mimeType || '').toLowerCase();
      if (mime === 'image/webp') return res.status(400).json({ error: 'WebP images are not supported for PDF conversion. Use PNG or JPEG.' });
      if (!IMAGES_TO_PDF_ALLOWED_MIME.has(mime)) return res.status(400).json({ error: 'Only PNG and JPEG image documents can be converted' });

      const content = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
      combinedInputBytes += content.length;
      if (combinedInputBytes > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Selected images exceed the 20 MB input limit' });
      images.push({ ...doc, content, mime });
    }

    let outputBuffer;
    try {
      outputBuffer = await buildImagesPdf(images, sizeKey);
    } catch {
      return res.status(400).json({ error: 'One or more images could not be embedded into the PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Generated PDF exceeds the 50 MB output limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_images_to_pdf_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentIds: documentIds,
        targetMatterId: matterId,
        outputDocumentId: documentIdNew,
        imageCount: images.length,
        pageSize: sizeKey,
        inputBytes: combinedInputBytes,
        outputBytes: outputBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save images PDF' });
  }
});

// Stamp / sign PDF — place a stored signature or stamp image onto one page.
// This is image placement only, not a certified electronic signature.

const STAMP_PDF_ALLOWED_ASSET_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg']);
const STAMP_PDF_MAX_PLACEMENT_DIMENSION = 2000;

async function loadStampAsset(assetId) {
  const asset = await get('SELECT * FROM signature_assets WHERE id=? AND deletedAt IS NULL', [assetId]);
  if (!asset) return { error: 'Signature asset not found', status: 404 };
  const mime = String(asset.mimeType || '').toLowerCase();
  if (!STAMP_PDF_ALLOWED_ASSET_MIME.has(mime)) return { status: 400, error: 'Only PNG and JPEG signature/stamp images are supported for PDF placement' };
  return { asset, mime };
}

function computeStampedHeight(assetBuffer, mime, width) {
  // Approximate aspect ratio from image dimensions embedded in the buffer header.
  // For PNG: IHDR chunk at offset 16 stores 4-byte width, 4-byte height (big-endian).
  // For JPEG: parse SOF0 marker starting at offset 2 for height (2 bytes), width (2 bytes).
  let imgWidth = 0;
  let imgHeight = 0;
  try {
    if (mime === 'image/png' && assetBuffer.length > 32 && assetBuffer.slice(1, 4).toString() === 'PNG') {
      imgWidth = assetBuffer.readUInt32BE(16);
      imgHeight = assetBuffer.readUInt32BE(20);
    } else if (mime.startsWith('image/jpeg') && assetBuffer[0] === 0xFF && assetBuffer[1] === 0xD8) {
      for (let offset = 2; offset < assetBuffer.length - 9; ) {
        if (assetBuffer[offset] !== 0xFF) break;
        const marker = assetBuffer[offset + 1];
        if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
          imgHeight = assetBuffer.readUInt16BE(offset + 5);
          imgWidth = assetBuffer.readUInt16BE(offset + 7);
          break;
        }
        const segLen = assetBuffer.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
  } catch {
    // fall through to default aspect
  }
  if (imgWidth > 0 && imgHeight > 0) return (width / imgWidth) * imgHeight;
  return width; // fallback 1:1
}

app.post('/api/document-tools/stamp-pdf', requireStaff, async (req, res) => {
  try {
    const { documentId, assetId, pageNumber: rawPage, x: rawX, y: rawY, width: rawWidth, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!assetId) return res.status(400).json({ error: 'assetId is required' });
    if (rawPage === undefined || rawPage === null) return res.status(400).json({ error: 'pageNumber is required' });

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_stamp_pdf' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be stamped' });

    const loadResult = await loadStampAsset(assetId);
    if (loadResult.error) return res.status(loadResult.status || 400).json({ error: loadResult.error });
    const { asset, mime: assetMime } = loadResult;

    if (!canReadSignatureAsset(req, asset)) return res.status(403).json({ error: 'Signature asset access denied' });

    const pageNumber = Number(rawPage);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return res.status(400).json({ error: 'pageNumber must be a positive integer' });

    const x = Number(rawX);
    if (!Number.isFinite(x)) return res.status(400).json({ error: 'x must be a finite number' });

    const y = Number(rawY);
    if (!Number.isFinite(y)) return res.status(400).json({ error: 'y must be a finite number' });

    const width = Number(rawWidth);
    if (!Number.isFinite(width) || width <= 0 || width > STAMP_PDF_MAX_PLACEMENT_DIMENSION) {
      return res.status(400).json({ error: 'width must be a positive number not exceeding 2000' });
    }

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');

    const outputFilename = cleanPdfDownloadName(rawFilename || (doc.displayName || doc.name || 'document').replace(/\.pdf$/i, '') + '-stamped.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    if (pageNumber > sourcePdf.getPageCount()) {
      return res.status(400).json({ error: `Page ${pageNumber} is out of range — the PDF has ${sourcePdf.getPageCount()} page(s)` });
    }

    const assetBuffer = Buffer.isBuffer(asset.content) ? asset.content : Buffer.from(asset.content || '');
    const height = computeStampedHeight(assetBuffer, assetMime, width);

    let image;
    try {
      if (assetMime.startsWith('image/png')) {
        image = await sourcePdf.embedPng(assetBuffer);
      } else {
        image = await sourcePdf.embedJpg(assetBuffer);
      }
    } catch {
      return res.status(400).json({ error: 'Could not embed the signature/stamp image onto the PDF' });
    }

    const targetPage = sourcePdf.getPage(pageNumber - 1);
    targetPage.drawImage(image, { x, y, width, height });

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await sourcePdf.save());
    } catch {
      return res.status(500).json({ error: 'Could not save the stamped PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Stamped PDF exceeds the 50 MB output limit' });

    const clientId = await documentAuditClientId(doc, req);

    await recordAuditEvent(req, {
      action: 'document_tool_stamp_pdf_downloaded',
      entityType: 'document_tool',
      entityId: documentId,
      matterId: doc.matterId || '',
      clientId,
      metadata: {
        sourceDocumentId: documentId,
        sourceMatterId: doc.matterId || '',
        assetId,
        assetType: asset.assetType,
        pageNumber,
        placementX: x,
        placementY: y,
        width,
        height,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to stamp PDF' });
  }
});

app.post('/api/document-tools/stamp-pdf/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentId, assetId, pageNumber: rawPage, x: rawX, y: rawY, width: rawWidth, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!matterId) return res.status(400).json({ error: 'matterId is required' });
    if (!assetId) return res.status(400).json({ error: 'assetId is required' });
    if (rawPage === undefined || rawPage === null) return res.status(400).json({ error: 'pageNumber is required' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_stamp_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_stamp_pdf_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be stamped' });
    if (doc.matterId !== matterId) return res.status(400).json({ error: 'Document must belong to the target matter' });

    const loadResult = await loadStampAsset(assetId);
    if (loadResult.error) return res.status(loadResult.status || 400).json({ error: loadResult.error });
    const { asset, mime: assetMime } = loadResult;

    if (!canReadSignatureAsset(req, asset)) return res.status(403).json({ error: 'Signature asset access denied' });

    const pageNumber = Number(rawPage);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return res.status(400).json({ error: 'pageNumber must be a positive integer' });

    const x = Number(rawX);
    if (!Number.isFinite(x)) return res.status(400).json({ error: 'x must be a finite number' });

    const y = Number(rawY);
    if (!Number.isFinite(y)) return res.status(400).json({ error: 'y must be a finite number' });

    const width = Number(rawWidth);
    if (!Number.isFinite(width) || width <= 0 || width > STAMP_PDF_MAX_PLACEMENT_DIMENSION) {
      return res.status(400).json({ error: 'width must be a positive number not exceeding 2000' });
    }

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');

    const outputFilename = cleanPdfDownloadName(rawFilename || (doc.displayName || doc.name || 'document').replace(/\.pdf$/i, '') + '-stamped.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    if (pageNumber > sourcePdf.getPageCount()) {
      return res.status(400).json({ error: `Page ${pageNumber} is out of range — the PDF has ${sourcePdf.getPageCount()} page(s)` });
    }

    const assetBuffer = Buffer.isBuffer(asset.content) ? asset.content : Buffer.from(asset.content || '');
    const height = computeStampedHeight(assetBuffer, assetMime, width);

    let image;
    try {
      if (assetMime.startsWith('image/png')) {
        image = await sourcePdf.embedPng(assetBuffer);
      } else {
        image = await sourcePdf.embedJpg(assetBuffer);
      }
    } catch {
      return res.status(400).json({ error: 'Could not embed the signature/stamp image onto the PDF' });
    }

    const targetPage = sourcePdf.getPage(pageNumber - 1);
    targetPage.drawImage(image, { x, y, width, height });

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await sourcePdf.save());
    } catch {
      return res.status(500).json({ error: 'Could not save the stamped PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Stamped PDF exceeds the 50 MB output limit' });

    const docIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      docIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [docIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_stamp_pdf_saved',
      entityType: 'document_tool',
      entityId: docIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentId: documentId,
        sourceMatterId: doc.matterId || '',
        targetMatterId: matterId,
        outputDocumentId: docIdNew,
        assetId,
        assetType: asset.assetType,
        pageNumber,
        placementX: x,
        placementY: y,
        width,
        height,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save stamped PDF' });
  }
});

// --- PRODUCT-24B: Tenth-line numbering (appellate formatting) ---

app.post('/api/document-tools/tenth-line', requireStaff, async (req, res) => {
  try {
    const { documentId, startNumber: rawStart, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });

    const startNumber = rawStart === undefined || rawStart === null || rawStart === '' ? 10 : Number(rawStart);
    if (!Number.isInteger(startNumber) || startNumber < 1) return res.status(400).json({ error: 'startNumber must be a positive integer' });

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_tenth_line' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be processed' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || (doc.displayName || doc.name || 'document').replace(/\.pdf$/i, '') + '-tenth-lined.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const font = await sourcePdf.embedFont(StandardFonts.Helvetica);
    const interval = 10;
    const fontSize = 8;
    const topMargin = 72;
    const bottomMargin = 72;
    const rightMargin = 48;
    const lineSpacing = 14.4;

    const pages = sourcePdf.getPages();
    for (let p = 0; p < pages.length; p++) {
      const page = pages[p];
      const { width, height } = page.getSize();
      const printableLines = Math.floor((height - topMargin - bottomMargin) / lineSpacing);
      for (let markerLine = interval; markerLine <= printableLines; markerLine += interval) {
        const label = String(startNumber + ((markerLine / interval) - 1) * interval);
        const y = height - topMargin - (markerLine * lineSpacing);
        const x = width - rightMargin;
        page.drawText(label, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
    }

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await sourcePdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not generate tenth-lined PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const clientId = await documentAuditClientId(doc, req);
    await recordAuditEvent(req, {
      action: 'document_tool_tenth_line_downloaded',
      entityType: 'document_tool',
      entityId: documentId,
      matterId: doc.matterId || '',
      clientId,
      metadata: {
        sourceDocumentId: documentId,
        startNumber,
        interval,
        fontSize,
        pageCount: pages.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to add tenth-line numbering' });
  }
});

app.post('/api/document-tools/tenth-line/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentId, startNumber: rawStart, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!matterId) return res.status(400).json({ error: 'matterId is required' });

    const startNumber = rawStart === undefined || rawStart === null || rawStart === '' ? 10 : Number(rawStart);
    if (!Number.isInteger(startNumber) || startNumber < 1) return res.status(400).json({ error: 'startNumber must be a positive integer' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_tenth_line_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_tenth_line_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be processed' });
    if (doc.matterId !== matterId) return res.status(400).json({ error: 'Document must belong to the target matter' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || (doc.displayName || doc.name || 'document').replace(/\.pdf$/i, '') + '-tenth-lined.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const font = await sourcePdf.embedFont(StandardFonts.Helvetica);
    const interval = 10;
    const fontSize = 8;
    const topMargin = 72;
    const bottomMargin = 72;
    const rightMargin = 48;
    const lineSpacing = 14.4;

    const pages = sourcePdf.getPages();
    for (let p = 0; p < pages.length; p++) {
      const page = pages[p];
      const { width, height } = page.getSize();
      const printableLines = Math.floor((height - topMargin - bottomMargin) / lineSpacing);
      for (let markerLine = interval; markerLine <= printableLines; markerLine += interval) {
        const label = String(startNumber + ((markerLine / interval) - 1) * interval);
        const y = height - topMargin - (markerLine * lineSpacing);
        const x = width - rightMargin;
        page.drawText(label, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
    }

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await sourcePdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not generate tenth-lined PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_tenth_line_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentId: documentId,
        targetMatterId: matterId,
        outputDocumentId: documentIdNew,
        startNumber,
        interval,
        fontSize,
        pageCount: pages.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save tenth-lined PDF' });
  }
});

// --- end PRODUCT-24B ---

app.post('/api/document-tools/delete-pdf-pages', requireStaff, async (req, res) => {
  try {
    const { documentId, pages: rawPages, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (typeof rawPages !== 'string' || !rawPages.trim()) return res.status(400).json({ error: 'pages is required' });

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_delete_pdf_pages' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be processed' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'pages-removed.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const pageCount = sourcePdf.getPageCount();
    const parsed = parsePageRanges(rawPages, pageCount);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const removeSet = new Set(parsed.indices);
    if (removeSet.size >= pageCount) return res.status(400).json({ error: 'At least one page must remain.' });

    const allIndices = sourcePdf.getPageIndices();
    const remainingIndices = allIndices.filter(i => !removeSet.has(i));

    let outputBuffer;
    try {
      const outputPdf = await PDFLibDocument.create();
      const copiedPages = await outputPdf.copyPages(sourcePdf, remainingIndices);
      copiedPages.forEach(page => outputPdf.addPage(page));
      outputBuffer = Buffer.from(await outputPdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not delete the requested pages' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const clientId = await documentAuditClientId(doc, req);
    await recordAuditEvent(req, {
      action: 'document_tool_delete_pdf_pages_downloaded',
      entityType: 'document_tool',
      entityId: documentId,
      matterId: doc.matterId || '',
      clientId,
      metadata: {
        route: 'document_tool_delete_pdf_pages',
        sourceDocumentId: documentId,
        sourceMatterId: doc.matterId || '',
        pages: rawPages.trim(),
        removedPageCount: parsed.indices.length,
        remainingPageCount: remainingIndices.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to delete PDF pages' });
  }
});

app.post('/api/document-tools/delete-pdf-pages/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentId, pages: rawPages, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!matterId) return res.status(400).json({ error: 'matterId is required' });
    if (typeof rawPages !== 'string' || !rawPages.trim()) return res.status(400).json({ error: 'pages is required' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_delete_pdf_pages_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_delete_pdf_pages_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be processed' });
    if (doc.matterId !== matterId) return res.status(400).json({ error: 'Document must belong to the target matter' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'pages-removed.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const pageCount = sourcePdf.getPageCount();
    const parsed = parsePageRanges(rawPages, pageCount);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const removeSet = new Set(parsed.indices);
    if (removeSet.size >= pageCount) return res.status(400).json({ error: 'At least one page must remain.' });

    const allIndices = sourcePdf.getPageIndices();
    const remainingIndices = allIndices.filter(i => !removeSet.has(i));

    let outputBuffer;
    try {
      const outputPdf = await PDFLibDocument.create();
      const copiedPages = await outputPdf.copyPages(sourcePdf, remainingIndices);
      copiedPages.forEach(page => outputPdf.addPage(page));
      outputBuffer = Buffer.from(await outputPdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not delete the requested pages' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_delete_pdf_pages_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentId: documentId,
        targetMatterId: matterId,
        outputDocumentId: documentIdNew,
        pages: rawPages.trim(),
        removedPageCount: parsed.indices.length,
        remainingPageCount: remainingIndices.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save deleted PDF' });
  }
});

const VALID_PAGINATE_POSITIONS = new Set(['bottom-center', 'bottom-right', 'bottom-left']);

function paginateTextX(pageWidth, textWidth, position) {
  const margin = 36;
  if (position === 'bottom-left') return margin;
  if (position === 'bottom-right') return pageWidth - margin - textWidth;
  return (pageWidth - textWidth) / 2;
}

app.post('/api/document-tools/number-pdf-pages', requireStaff, async (req, res) => {
  try {
    const { documentId, startNumber: rawStart, position: rawPosition, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });

    const startNumber = rawStart === undefined || rawStart === null || rawStart === '' ? 1 : Number(rawStart);
    if (!Number.isInteger(startNumber) || startNumber < 1) return res.status(400).json({ error: 'startNumber must be a positive integer' });
    if (startNumber > 99999) return res.status(400).json({ error: 'startNumber must be 99999 or less' });

    const position = rawPosition || 'bottom-center';
    if (!VALID_PAGINATE_POSITIONS.has(position)) return res.status(400).json({ error: 'position must be one of: bottom-center, bottom-right, bottom-left' });

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_number_pdf_pages' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be processed' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'paginated-document.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const font = await sourcePdf.embedFont(StandardFonts.Helvetica);
    const fontSize = 10;
    const fontColor = rgb(0, 0, 0);
    const bottomMargin = 24;

    const pages = sourcePdf.getPages();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();
      const number = startNumber + i;
      const text = String(number);
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const x = paginateTextX(width, textWidth, position);
      const y = bottomMargin + fontSize * 0.35;
      page.drawText(text, { x, y, size: fontSize, font, color: fontColor });
    }

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await sourcePdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not generate paginated PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const clientId = await documentAuditClientId(doc, req);
    await recordAuditEvent(req, {
      action: 'document_tool_number_pdf_pages_downloaded',
      entityType: 'document_tool',
      entityId: documentId,
      matterId: doc.matterId || '',
      clientId,
      metadata: {
        route: 'document_tool_number_pdf_pages',
        sourceDocumentId: documentId,
        sourceMatterId: doc.matterId || '',
        startNumber,
        position,
        pageCount: pages.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: outputFilename,
      },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to add page numbers' });
  }
});

app.post('/api/document-tools/number-pdf-pages/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentId, startNumber: rawStart, position: rawPosition, filename: rawFilename } = req.body || {};

    if (!documentId) return res.status(400).json({ error: 'documentId is required' });
    if (!matterId) return res.status(400).json({ error: 'matterId is required' });

    const startNumber = rawStart === undefined || rawStart === null || rawStart === '' ? 1 : Number(rawStart);
    if (!Number.isInteger(startNumber) || startNumber < 1) return res.status(400).json({ error: 'startNumber must be a positive integer' });
    if (startNumber > 99999) return res.status(400).json({ error: 'startNumber must be 99999 or less' });

    const position = rawPosition || 'bottom-center';
    if (!VALID_PAGINATE_POSITIONS.has(position)) return res.status(400).json({ error: 'position must be one of: bottom-center, bottom-right, bottom-left' });

    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_number_pdf_pages_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_number_pdf_pages_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Document access denied' });
    }
    if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be processed' });
    if (doc.matterId !== matterId) return res.status(400).json({ error: 'Document must belong to the target matter' });

    const inputContent = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    if (inputContent.length > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Document exceeds the 20 MB input limit' });

    const outputFilename = cleanPdfDownloadName(rawFilename || 'paginated-document.pdf');

    let sourcePdf;
    try {
      sourcePdf = await PDFLibDocument.load(inputContent, { ignoreEncryption: false });
    } catch {
      return res.status(400).json({ error: 'Could not read PDF — it may be corrupt or encrypted' });
    }

    const font = await sourcePdf.embedFont(StandardFonts.Helvetica);
    const fontSize = 10;
    const fontColor = rgb(0, 0, 0);
    const bottomMargin = 24;

    const pages = sourcePdf.getPages();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();
      const number = startNumber + i;
      const text = String(number);
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const x = paginateTextX(width, textWidth, position);
      const y = bottomMargin + fontSize * 0.35;
      page.drawText(text, { x, y, size: fontSize, font, color: fontColor });
    }

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await sourcePdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not generate paginated PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    await recordAuditEvent(req, {
      action: 'document_tool_number_pdf_pages_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata: {
        sourceDocumentId: documentId,
        targetMatterId: matterId,
        outputDocumentId: documentIdNew,
        startNumber,
        position,
        pageCount: pages.length,
        inputBytes: inputContent.length,
        outputBytes: outputBuffer.length,
        filename: cleanName,
        clientVisible: false,
      },
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save paginated PDF' });
  }
});

// --- Court Bundle index page (PRODUCT-14J) ---
// The index is always a single A4 portrait page (points) titled "BUNDLE INDEX",
// inserted as the first page of the bundle. Uses bundled standard fonts only.
const BUNDLE_INDEX_PAGE_SIZE = [595.28, 841.89];
const BUNDLE_INDEX_TITLE = 'BUNDLE INDEX';
const MAX_INDEX_LABEL_LENGTH = 80;

// Reduce a label to WinAnsi-safe printable characters so pdf-lib's standard
// font encoding can never throw on user-supplied text, then cap its length.
// Falls back to the document name when the label is empty after sanitizing.
function sanitizeIndexLabel(raw, fallback) {
  const clean = value => {
    const str = String(value == null ? '' : value);
    let out = '';
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) { out += ' '; continue; } // strip control characters
      if (code > 0xff) { out += '?'; continue; }                                    // map outside-WinAnsi to '?'
      out += ch;
    }
    return out.replace(/\s+/g, ' ').trim();
  };
  const safeFallback = clean(fallback) || 'Document';
  const safeLabel = clean(raw);
  return (safeLabel || safeFallback).slice(0, MAX_INDEX_LABEL_LENGTH);
}

// Starting page for each document in the bundle. Front matter precedes the
// documents: an optional cover page (coverPages) followed by the index page.
// With no cover the index occupies physical page 1, so the first document
// begins at physical page 2 (the original behaviour). With a cover the index is
// physical page 2 and the first document begins at physical page 3. When
// pagination is enabled the value honours startNumber so the printed numbers
// match; otherwise it is the physical 1-based position.
function bundleIndexStartingPages(pageCounts, { paginate, startNumber, coverPages = 0, includeDividers = false }) {
  const starts = [];
  let cumulative = 0;
  for (let i = 0; i < pageCounts.length; i++) {
    const adjust = includeDividers ? i : 0;
    const physicalStart = 2 + coverPages + adjust + cumulative;
    starts.push(paginate ? startNumber + (physicalStart - 1) : physicalStart);
    cumulative += pageCounts[i];
  }
  return starts;
}

// Truncate text with an ASCII ellipsis so it fits within maxWidth at the given
// font size.
function ellipsizeToWidth(text, font, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && font.widthOfTextAtSize(`${trimmed}...`, size) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}...`;
}

// Build the single A4 index page and insert it as the first page of bundlePdf.
// rows: [{ seq, label, startPage }].
async function prependBundleIndexPage(bundlePdf, rows) {
  const page = bundlePdf.insertPage(0, BUNDLE_INDEX_PAGE_SIZE);
  const { width, height } = page.getSize();
  const helvetica = await bundlePdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await bundlePdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const margin = 56;

  const titleSize = 18;
  page.drawText(BUNDLE_INDEX_TITLE, { x: margin, y: height - margin - titleSize, size: titleSize, font: helveticaBold, color: black });

  const numX = margin;
  const labelX = margin + 34;
  const pageColWidth = 96;
  const pageX = width - margin - pageColWidth;
  const labelMaxWidth = pageX - labelX - 12;

  const headerSize = 11;
  let y = height - margin - titleSize - 30;
  page.drawText('#', { x: numX, y, size: headerSize, font: helveticaBold, color: black });
  page.drawText('Document', { x: labelX, y, size: headerSize, font: helveticaBold, color: black });
  page.drawText('Starting page', { x: pageX, y, size: headerSize, font: helveticaBold, color: black });

  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.75, color: black });

  const rowSize = 11;
  const rowGap = 22;
  y -= rowGap;
  for (const row of rows) {
    page.drawText(String(row.seq), { x: numX, y, size: rowSize, font: helvetica, color: black });
    page.drawText(ellipsizeToWidth(row.label, helvetica, rowSize, labelMaxWidth), { x: labelX, y, size: rowSize, font: helvetica, color: black });
    page.drawText(String(row.startPage), { x: pageX, y, size: rowSize, font: helvetica, color: black });
    y -= rowGap;
  }
}

// --- Court Bundle cover page (PRODUCT-14K) ---
// Optional single A4 portrait cover page generated from editable free-text
// fields and inserted before the index/documents. Uses bundled standard fonts
// only (Helvetica / Helvetica-Bold), black text, no logo and no template system.
const BUNDLE_COVER_DEFAULT_TITLE = 'COURT BUNDLE';
const COVER_FIELD_CAPS = {
  title: 120,
  court: 120,
  caseNumber: 120,
  caseTitle: 200,
  bundleTitle: 120,
  preparedBy: 120,
  date: 80,
};

// Reduce a cover field to WinAnsi-safe printable characters (mirrors the index
// label sanitizer): strip control characters and newlines, map outside-WinAnsi
// code points to '?', collapse whitespace and hard-cap the length. Never throws.
function sanitizeCoverField(raw, maxLength) {
  const str = String(raw == null ? '' : raw);
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) { out += ' '; continue; } // strip control characters / newlines
    if (code > 0xff) { out += '?'; continue; }                                    // map outside-WinAnsi to '?'
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxLength));
}

// Build the sanitized cover field set from an untrusted request value. A missing,
// null, array or non-object cover is treated as {}. All fields are optional.
function buildCoverFields(rawCover) {
  const src = rawCover && typeof rawCover === 'object' && !Array.isArray(rawCover) ? rawCover : {};
  const fields = {};
  for (const [key, cap] of Object.entries(COVER_FIELD_CAPS)) {
    fields[key] = sanitizeCoverField(src[key], cap);
  }
  return fields;
}

// Wrap text into at most maxLines lines that each fit maxWidth at the given
// font size. Overflow beyond maxLines is folded into the final line and
// ellipsized; a single over-long word is ellipsized by ellipsizeToWidth.
function wrapCoverText(text, font, size, maxWidth, maxLines) {
  const words = String(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) {
    return lines.map(line => ellipsizeToWidth(line, font, size, maxWidth));
  }
  const kept = lines.slice(0, maxLines - 1).map(line => ellipsizeToWidth(line, font, size, maxWidth));
  kept.push(ellipsizeToWidth(lines.slice(maxLines - 1).join(' '), font, size, maxWidth));
  return kept;
}

// Build the single A4 cover page and insert it as the first page of bundlePdf.
// Fields are already sanitized; the title falls back to COURT BUNDLE when blank.
async function prependBundleCoverPage(bundlePdf, cover) {
  const page = bundlePdf.insertPage(0, BUNDLE_INDEX_PAGE_SIZE);
  const { width, height } = page.getSize();
  const helvetica = await bundlePdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await bundlePdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const margin = 64;
  const maxWidth = width - margin * 2;
  let y = height - 120;

  const drawCentered = (text, size, font, gapAfter, maxLines = 1) => {
    const lines = maxLines > 1
      ? wrapCoverText(text, font, size, maxWidth, maxLines)
      : [ellipsizeToWidth(text, font, size, maxWidth)];
    for (const line of lines) {
      if (!line) continue;
      const textWidth = font.widthOfTextAtSize(line, size);
      page.drawText(line, { x: Math.max(margin, (width - textWidth) / 2), y, size, font, color: black });
      y -= size + 6;
    }
    y -= gapAfter;
  };

  const title = cover.title || BUNDLE_COVER_DEFAULT_TITLE;
  if (cover.court) drawCentered(cover.court, 13, helveticaBold, 8, 2);
  if (cover.caseNumber) drawCentered(cover.caseNumber, 12, helvetica, 24, 1);
  if (cover.caseTitle) drawCentered(cover.caseTitle, 14, helveticaBold, 30, 3);
  drawCentered(title, 26, helveticaBold, 16, 1);
  if (cover.bundleTitle) drawCentered(cover.bundleTitle, 16, helveticaBold, 30, 2);
  if (cover.preparedBy) drawCentered(cover.preparedBy, 12, helvetica, 6, 2);
  if (cover.date) drawCentered(cover.date, 12, helvetica, 0, 1);
}

// Build the sanitized label for a divider page. Prefers dividerLabels[doc.id],
// falls back to documentLabels[doc.id], then to doc.displayName/doc.name.
// Reuses sanitizeIndexLabel for safe WinAnsi output.
function buildDividerLabel(doc, dividerLabels, documentLabels) {
  const fallback = doc.displayName || doc.name || doc.id;
  const labels1 = dividerLabels && typeof dividerLabels === 'object' && !Array.isArray(dividerLabels) ? dividerLabels : {};
  const labels2 = documentLabels && typeof documentLabels === 'object' && !Array.isArray(documentLabels) ? documentLabels : {};
  const fromDivider = labels1[doc.id];
  if (fromDivider !== undefined && String(fromDivider).trim()) {
    return sanitizeIndexLabel(fromDivider, fallback);
  }
  const fromDocument = labels2[doc.id];
  if (fromDocument !== undefined && String(fromDocument).trim()) {
    return sanitizeIndexLabel(fromDocument, fallback);
  }
  return sanitizeIndexLabel('', fallback);
}

// Insert a single A4 divider page at the given position in bundlePdf.
// Renders "SECTION N" and the label centered on the page using bundled
// standard fonts (Helvetica / HelveticaBold), no logo, no custom fonts.
async function insertDividerPage(bundlePdf, position, label, seq) {
  const page = bundlePdf.insertPage(position, BUNDLE_INDEX_PAGE_SIZE);
  const { width, height } = page.getSize();
  const helvetica = await bundlePdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await bundlePdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const sectionText = `SECTION ${seq}`;
  const sectionSize = 18;
  const sectionWidth = helveticaBold.widthOfTextAtSize(sectionText, sectionSize);
  page.drawText(sectionText, {
    x: (width - sectionWidth) / 2,
    y: height / 2 + 20,
    size: sectionSize,
    font: helveticaBold,
    color: black,
  });
  const labelSize = 14;
  const labelWidth = helvetica.widthOfTextAtSize(label, labelSize);
  page.drawText(label, {
    x: (width - labelWidth) / 2,
    y: height / 2 - 30,
    size: labelSize,
    font: helvetica,
    color: black,
  });
}

// --- Court Bundle PDF bookmarks / outlines (PRODUCT-14M) ---
// Optional top-level PDF navigation entries (no nesting in v1) for the cover,
// index and each selected source document / divider section. Labels are reduced
// to WinAnsi-safe printable text and length-capped, mirroring the index/divider
// sanitizers, so PDFString.of() can never throw on user-supplied text.
const MAX_BOOKMARK_LABEL_LENGTH = 120;
function sanitizeBookmarkLabel(raw, fallback) {
  const clean = value => {
    const str = String(value == null ? '' : value);
    let out = '';
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) { out += ' '; continue; } // strip control characters
      if (code > 0xff) { out += '?'; continue; }                                    // map outside-WinAnsi to '?'
      out += ch;
    }
    return out.replace(/\s+/g, ' ').trim();
  };
  const safeFallback = clean(fallback) || 'Document';
  const safeLabel = clean(raw);
  return (safeLabel || safeFallback).slice(0, MAX_BOOKMARK_LABEL_LENGTH);
}

// Section bookmark label, preferring dividerLabels[doc.id], then
// documentLabels[doc.id], then doc.displayName / doc.name, then 'Document'.
function buildBookmarkLabel(doc, dividerLabels, documentLabels) {
  const fallback = doc.displayName || doc.name || 'Document';
  const labels1 = dividerLabels && typeof dividerLabels === 'object' && !Array.isArray(dividerLabels) ? dividerLabels : {};
  const labels2 = documentLabels && typeof documentLabels === 'object' && !Array.isArray(documentLabels) ? documentLabels : {};
  const fromDivider = labels1[doc.id];
  if (fromDivider !== undefined && String(fromDivider).trim()) return sanitizeBookmarkLabel(fromDivider, fallback);
  const fromDocument = labels2[doc.id];
  if (fromDocument !== undefined && String(fromDocument).trim()) return sanitizeBookmarkLabel(fromDocument, fallback);
  return sanitizeBookmarkLabel('', fallback);
}

// Build the ordered v1 bookmark entries against the final assembled layout:
// optional cover (physical page 1), optional index, then one entry per source
// document pointing at its divider page (when dividers are enabled) or otherwise
// the first page of that source document. Page indices are 0-based.
function buildBundleBookmarkEntries({ includeCover, includeIndex, includeDividers, sourceDocs, sourcePageCounts, dividerLabels, documentLabels }) {
  const entries = [];
  const coverPages = includeCover ? 1 : 0;
  const indexPages = includeIndex ? 1 : 0;
  if (includeCover) entries.push({ title: 'Cover Page', pageIndex: 0 });
  if (includeIndex) entries.push({ title: 'Index', pageIndex: coverPages });
  let offset = coverPages + indexPages;
  for (let i = 0; i < sourceDocs.length; i++) {
    entries.push({ title: buildBookmarkLabel(sourceDocs[i], dividerLabels, documentLabels), pageIndex: offset });
    offset += (includeDividers ? 1 : 0) + sourcePageCounts[i];
  }
  return entries;
}

// Attach a flat /Outlines tree to pdfDoc using pdf-lib low-level objects. Each
// entry may carry a pageRef or a 0-based pageIndex (resolved against the final
// document). Titles use PDFString.of so they serialize as strings, not names.
// Returns the number of bookmarks written. Never throws on its own callers wrap
// it defensively, but invalid entries are simply skipped.
function addPdfOutlines(pdfDoc, bookmarkEntries) {
  if (!Array.isArray(bookmarkEntries) || bookmarkEntries.length === 0) return 0;
  const ctx = pdfDoc.context;
  const pageCount = pdfDoc.getPageCount();
  if (pageCount === 0) return 0;
  const entries = [];
  for (const entry of bookmarkEntries) {
    if (!entry || typeof entry.title !== 'string' || !entry.title) continue;
    let pageRef = entry.pageRef || null;
    if (!pageRef && Number.isInteger(entry.pageIndex)) {
      const idx = Math.min(Math.max(entry.pageIndex, 0), pageCount - 1);
      pageRef = pdfDoc.getPage(idx).ref;
    }
    if (pageRef) entries.push({ title: entry.title, pageRef });
  }
  if (entries.length === 0) return 0;

  // Reserve refs up front so items can reference the root as their /Parent and
  // each other via /Prev and /Next.
  const rootRef = ctx.nextRef();
  const itemRefs = entries.map(() => ctx.nextRef());
  entries.forEach((entry, i) => {
    const dict = ctx.obj({ Parent: rootRef, Dest: [entry.pageRef, 'XYZ', null, null, null] });
    dict.set(PDFName.of('Title'), PDFString.of(entry.title));
    if (i > 0) dict.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < entries.length - 1) dict.set(PDFName.of('Next'), itemRefs[i + 1]);
    ctx.assign(itemRefs[i], dict);
  });
  const root = ctx.obj({ Type: 'Outlines', First: itemRefs[0], Last: itemRefs[itemRefs.length - 1], Count: entries.length });
  ctx.assign(rootRef, root);
  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
  return entries.length;
}

// --- Court Bundle generation certificate (PRODUCT-14N) ---
// Optional single A4 portrait page appended to the END of the bundle that
// records how the bundle was generated. All content is server-derived (firm
// settings, the fetched matter/client, the requesting user and the actual
// option flags) — there is no client free-text in v1. Every string is reduced
// to WinAnsi-safe text via sanitizeCoverField so drawText/embed can never throw.
const BUNDLE_CERT_TITLE = 'BUNDLE GENERATION CERTIFICATE';
const BUNDLE_CERT_STATEMENT = 'This certificate records that this bundle was generated from the documents selected in LexFlow for the matter identified below. It is a generation record for internal filing purposes and does not certify compliance with any court filing rule or practice direction.';

// Build the sanitized, ordered label/value rows for the certificate page from
// server-derived values. options is the actual booleans used for assembly.
function buildBundleCertificateData({ firmName, matterTitle, matterReference, clientName, bundleTitle, sourceCount, options, totalPages, generatedBy, generatedAt }) {
  const s = value => sanitizeCoverField(value, 200);
  const yn = flag => (flag ? 'Yes' : 'No');
  const optionsSummary = `Cover: ${yn(options.includeCover)}, Index: ${yn(options.includeIndex)}, Dividers: ${yn(options.includeDividers)}, Page numbers: ${yn(options.paginate)}, Bookmarks: ${yn(options.includeBookmarks)}`;
  return {
    rows: [
      { label: 'Firm', value: s(firmName) },
      { label: 'Matter', value: s(matterTitle) },
      { label: 'Matter reference', value: s(matterReference) },
      { label: 'Client', value: s(clientName) },
      { label: 'Bundle title', value: s(bundleTitle) },
      { label: 'Source documents', value: s(String(sourceCount)) },
      { label: 'Options included', value: s(optionsSummary) },
      { label: 'Total pages', value: s(String(totalPages)) },
      { label: 'Generated by', value: s(generatedBy) },
      { label: 'Generated', value: s(generatedAt) },
    ],
  };
}

// Append the single A4 certificate page as the LAST page of bundlePdf and
// return its page ref (for an optional bookmark). Values in certData.rows are
// already sanitized. Uses bundled standard fonts only, black text, no logo.
async function appendBundleCertificatePage(bundlePdf, certData) {
  const page = bundlePdf.addPage(BUNDLE_INDEX_PAGE_SIZE);
  const { width, height } = page.getSize();
  const helvetica = await bundlePdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await bundlePdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const margin = 56;
  const maxWidth = width - margin * 2;

  let y = height - margin - 18;
  page.drawText(BUNDLE_CERT_TITLE, { x: margin, y, size: 18, font: helveticaBold, color: black });
  y -= 32;

  const statementSize = 11;
  for (const line of wrapCoverText(BUNDLE_CERT_STATEMENT, helvetica, statementSize, maxWidth, 6)) {
    page.drawText(line, { x: margin, y, size: statementSize, font: helvetica, color: black });
    y -= statementSize + 6;
  }
  y -= 16;

  const rowSize = 11;
  const rowGap = 24;
  const labelColWidth = 150;
  const valueX = margin + labelColWidth;
  const valueMaxWidth = width - margin - valueX;
  for (const row of certData.rows) {
    page.drawText(row.label, { x: margin, y, size: rowSize, font: helveticaBold, color: black });
    page.drawText(ellipsizeToWidth(row.value || '-', helvetica, rowSize, valueMaxWidth), { x: valueX, y, size: rowSize, font: helvetica, color: black });
    y -= rowGap;
  }
  return page.ref;
}

// Gather server-side certificate content and append the page to bundlePdf,
// returning its page ref. Shared by the download and save routes so the data
// sourcing stays identical. totalPages is computed from the known source page
// counts and option flags plus the certificate page itself; this matches the
// final getPageCount() because the certificate is appended before front matter.
async function generateBundleCertificate(req, { matter, sourceDocs, sourcePageCounts, includeCover, includeIndex, includeDividers, paginate, includeBookmarks, coverFields, outputFilename, bundlePdf }) {
  const firm = await getFirmSettings();
  const certClient = matter.clientId ? await get('SELECT name FROM clients WHERE id=?', [matter.clientId]) : null;
  const certUser = await get('SELECT fullName,email FROM users WHERE id=?', [req.user.userId]);
  const totalPages = sourcePageCounts.reduce((a, b) => a + b, 0)
    + (includeDividers ? sourceDocs.length : 0)
    + (includeIndex ? 1 : 0)
    + (includeCover ? 1 : 0)
    + 1;
  const certData = buildBundleCertificateData({
    firmName: firm?.name || '',
    matterTitle: matter.title || '',
    matterReference: matter.reference || matter.caseNo || '',
    clientName: certClient?.name || '',
    bundleTitle: coverFields.bundleTitle || outputFilename,
    sourceCount: sourceDocs.length,
    options: { includeCover, includeIndex, includeDividers, paginate, includeBookmarks },
    totalPages,
    generatedBy: certUser?.fullName || certUser?.email || '',
    generatedAt: `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`,
  });
  return appendBundleCertificatePage(bundlePdf, certData);
}

app.post('/api/document-tools/court-bundle', requireStaff, async (req, res) => {
  try {
    const { matterId, documentIds: rawDocumentIds, filename: rawFilename, paginate: rawPaginate, startNumber: rawStart, position: rawPosition, includeIndex: rawIncludeIndex, documentLabels: rawDocumentLabels, includeCover: rawIncludeCover, cover: rawCover, includeDividers: rawIncludeDividers, dividerLabels: rawDividerLabels, includeBookmarks: rawIncludeBookmarks, includeCertificate: rawIncludeCertificate } = req.body || {};

    if (!matterId) return res.status(400).json({ error: 'matterId is required' });
    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_court_bundle' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const documentIds = Array.isArray(rawDocumentIds)
      ? rawDocumentIds.map(id => String(id || '').trim()).filter(Boolean)
      : null;
    if (!documentIds) return res.status(400).json({ error: 'documentIds must be an array' });
    if (documentIds.length < 2) return res.status(400).json({ error: 'Select at least 2 PDF documents' });
    if (documentIds.length > MAX_MERGE_PDF_COUNT) return res.status(400).json({ error: `Select no more than ${MAX_MERGE_PDF_COUNT} PDF documents` });
    if (new Set(documentIds).size !== documentIds.length) return res.status(400).json({ error: 'Duplicate document IDs are not allowed' });

    const paginate = rawPaginate === true;
    let startNumber = 1;
    let position = '';
    if (paginate) {
      startNumber = rawStart === undefined || rawStart === null || rawStart === '' ? 1 : Number(rawStart);
      if (!Number.isInteger(startNumber) || startNumber < 1) return res.status(400).json({ error: 'startNumber must be a positive integer' });
      if (startNumber > 99999) return res.status(400).json({ error: 'startNumber must be 99999 or less' });
      position = rawPosition || 'bottom-center';
      if (!VALID_PAGINATE_POSITIONS.has(position)) return res.status(400).json({ error: 'position must be one of: bottom-center, bottom-right, bottom-left' });
    }

    const includeIndex = rawIncludeIndex === true;
    const documentLabels = rawDocumentLabels && typeof rawDocumentLabels === 'object' && !Array.isArray(rawDocumentLabels) ? rawDocumentLabels : {};
    const includeCover = rawIncludeCover === true;
    const coverFields = buildCoverFields(rawCover);
    const coverFieldCount = Object.values(coverFields).filter(Boolean).length;
    const includeDividers = rawIncludeDividers === true;
    const dividerLabels = rawDividerLabels && typeof rawDividerLabels === 'object' && !Array.isArray(rawDividerLabels) ? rawDividerLabels : {};
    const includeBookmarks = rawIncludeBookmarks === true;
    const includeCertificate = rawIncludeCertificate === true;

    const outputFilename = cleanPdfDownloadName(rawFilename || 'court-bundle.pdf');
    const sourceDocs = [];
    let combinedInputBytes = 0;

    for (const documentId of documentIds) {
      const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
        await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_court_bundle' } }).catch(() => {});
        return res.status(403).json({ error: 'Document access denied' });
      }
      if (doc.matterId !== matterId) return res.status(400).json({ error: 'All PDFs must belong to the target matter' });
      if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be included' });

      const content = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
      combinedInputBytes += content.length;
      if (combinedInputBytes > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Selected PDFs exceed the 20 MB input limit' });
      sourceDocs.push({ ...doc, content });
    }

    const bundlePdf = await PDFLibDocument.create();
    const sourcePageCounts = [];
    try {
      for (const doc of sourceDocs) {
        const sourcePdf = await PDFLibDocument.load(doc.content, { ignoreEncryption: false });
        const copiedPages = await bundlePdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach(page => bundlePdf.addPage(page));
        sourcePageCounts.push(copiedPages.length);
      }
    } catch {
      return res.status(400).json({ error: 'One or more selected PDFs could not be read — they may be corrupt or encrypted' });
    }

    // Append the generation certificate as the LAST page now, before any front
    // matter is inserted at position 0. This keeps it trailing, leaves index
    // page-number math untouched, lets pagination number it automatically and
    // gives bookmark generation a stable page ref. The certificate is the
    // requested artifact, so a failure here aborts the bundle rather than
    // silently omitting it.
    let certificatePageRef = null;
    if (includeCertificate) {
      try {
        certificatePageRef = await generateBundleCertificate(req, { matter, sourceDocs, sourcePageCounts, includeCover, includeIndex, includeDividers, paginate, includeBookmarks, coverFields, outputFilename, bundlePdf });
      } catch {
        return res.status(400).json({ error: 'Could not generate the bundle certificate page' });
      }
    }

    // Insert divider pages before each source document (reverse order to avoid
    // shifting page index arithmetic). Each divider appears between the index
    // (or cover) and its corresponding source PDF.
    if (includeDividers) {
      for (let i = sourceDocs.length - 1; i >= 0; i--) {
        const doc = sourceDocs[i];
        const label = buildDividerLabel(doc, dividerLabels, documentLabels);
        const pos = sourcePageCounts.slice(0, i).reduce((a, b) => a + b, 0);
        try {
          await insertDividerPage(bundlePdf, pos, label, i + 1);
        } catch {
          return res.status(400).json({ error: 'Could not generate divider page' });
        }
      }
    }

    // Insert front matter so the cover is physical page 1 and the index follows
    // it: add the index at position 0 first, then the cover at position 0.
    if (includeIndex) {
      const startingPages = bundleIndexStartingPages(sourcePageCounts, { paginate, startNumber, coverPages: includeCover ? 1 : 0, includeDividers });
      const indexRows = sourceDocs.map((doc, i) => ({
        seq: i + 1,
        label: sanitizeIndexLabel(documentLabels[doc.id], doc.displayName || doc.name || doc.id),
        startPage: startingPages[i],
      }));
      try {
        await prependBundleIndexPage(bundlePdf, indexRows);
      } catch {
        return res.status(400).json({ error: 'Could not generate the bundle index page' });
      }
    }

    if (includeCover) {
      try {
        await prependBundleCoverPage(bundlePdf, coverFields);
      } catch {
        return res.status(400).json({ error: 'Could not generate the bundle cover page' });
      }
    }

    if (paginate) {
      const font = await bundlePdf.embedFont(StandardFonts.Helvetica);
      const fontSize = 10;
      const fontColor = rgb(0, 0, 0);
      const bottomMargin = 24;
      const pages = bundlePdf.getPages();
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const number = startNumber + i;
        const text = String(number);
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        const x = paginateTextX(width, textWidth, position);
        const y = bottomMargin + fontSize * 0.35;
        page.drawText(text, { x, y, size: fontSize, font, color: fontColor });
      }
    }

    // Optional PDF bookmarks / outline. Built against the final assembled layout
    // (cover, index and divider front/section matter already in place). Outline
    // construction never aborts bundle generation: on failure we fall back to a
    // valid PDF with no bookmarks (bookmarkCount stays 0).
    let bookmarkCount = 0;
    if (includeBookmarks) {
      try {
        const bookmarkEntries = buildBundleBookmarkEntries({ includeCover, includeIndex, includeDividers, sourceDocs, sourcePageCounts, dividerLabels, documentLabels });
        if (includeCertificate && certificatePageRef) bookmarkEntries.push({ title: 'Bundle Certificate', pageRef: certificatePageRef });
        bookmarkCount = addPdfOutlines(bundlePdf, bookmarkEntries);
      } catch {
        bookmarkCount = 0;
      }
    }

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await bundlePdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not generate court bundle PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const pageCount = bundlePdf.getPageCount();
    const endNumber = paginate ? startNumber + pageCount - 1 : undefined;

    const clientId = await documentAuditClientId(sourceDocs[0], req);
    const metadata = {
      sourceDocumentIds: documentIds,
      sourceCount: sourceDocs.length,
      matterId,
      pageCount,
      paginate: !!paginate,
      inputBytes: combinedInputBytes,
      outputBytes: outputBuffer.length,
      filename: outputFilename,
    };
    if (paginate) {
      metadata.startNumber = startNumber;
      metadata.endNumber = endNumber;
      metadata.position = position;
    }
    metadata.includeIndex = includeIndex;
    if (includeIndex) {
      metadata.indexPageCount = 1;
      metadata.labelCount = sourceDocs.filter(doc => Object.prototype.hasOwnProperty.call(documentLabels, doc.id)).length;
    }
    metadata.includeCover = includeCover;
    metadata.coverFieldCount = includeCover ? coverFieldCount : 0;
    metadata.includeDividers = includeDividers;
    metadata.dividerCount = includeDividers ? sourceDocs.length : 0;
    metadata.includeBookmarks = includeBookmarks;
    if (includeBookmarks) metadata.bookmarkCount = bookmarkCount;
    metadata.includeCertificate = includeCertificate;

    await recordAuditEvent(req, {
      action: 'document_tool_court_bundle_downloaded',
      entityType: 'document_tool',
      entityId: matterId,
      matterId,
      clientId,
      metadata,
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(outputBuffer);
  } catch {
    res.status(500).json({ error: 'Unable to create court bundle' });
  }
});

app.post('/api/document-tools/court-bundle/save', requireAdvocateOrAdmin, async (req, res) => {
  try {
    const { matterId, documentIds: rawDocumentIds, filename: rawFilename, paginate: rawPaginate, startNumber: rawStart, position: rawPosition, includeIndex: rawIncludeIndex, documentLabels: rawDocumentLabels, includeCover: rawIncludeCover, cover: rawCover, includeDividers: rawIncludeDividers, dividerLabels: rawDividerLabels, includeBookmarks: rawIncludeBookmarks, includeCertificate: rawIncludeCertificate } = req.body || {};

    if (!matterId) return res.status(400).json({ error: 'matterId is required' });
    const matter = await get('SELECT * FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, metadata: { reason: 'insufficient permissions', route: 'document_tool_court_bundle_save' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }

    const documentIds = Array.isArray(rawDocumentIds)
      ? rawDocumentIds.map(id => String(id || '').trim()).filter(Boolean)
      : null;
    if (!documentIds) return res.status(400).json({ error: 'documentIds must be an array' });
    if (documentIds.length < 2) return res.status(400).json({ error: 'Select at least 2 PDF documents' });
    if (documentIds.length > MAX_MERGE_PDF_COUNT) return res.status(400).json({ error: `Select no more than ${MAX_MERGE_PDF_COUNT} PDF documents` });
    if (new Set(documentIds).size !== documentIds.length) return res.status(400).json({ error: 'Duplicate document IDs are not allowed' });

    const paginate = rawPaginate === true;
    let startNumber = 1;
    let position = '';
    if (paginate) {
      startNumber = rawStart === undefined || rawStart === null || rawStart === '' ? 1 : Number(rawStart);
      if (!Number.isInteger(startNumber) || startNumber < 1) return res.status(400).json({ error: 'startNumber must be a positive integer' });
      if (startNumber > 99999) return res.status(400).json({ error: 'startNumber must be 99999 or less' });
      position = rawPosition || 'bottom-center';
      if (!VALID_PAGINATE_POSITIONS.has(position)) return res.status(400).json({ error: 'position must be one of: bottom-center, bottom-right, bottom-left' });
    }

    const includeIndex = rawIncludeIndex === true;
    const documentLabels = rawDocumentLabels && typeof rawDocumentLabels === 'object' && !Array.isArray(rawDocumentLabels) ? rawDocumentLabels : {};
    const includeCover = rawIncludeCover === true;
    const coverFields = buildCoverFields(rawCover);
    const coverFieldCount = Object.values(coverFields).filter(Boolean).length;
    const includeDividers = rawIncludeDividers === true;
    const dividerLabels = rawDividerLabels && typeof rawDividerLabels === 'object' && !Array.isArray(rawDividerLabels) ? rawDividerLabels : {};
    const includeBookmarks = rawIncludeBookmarks === true;
    const includeCertificate = rawIncludeCertificate === true;

    const outputFilename = cleanPdfDownloadName(rawFilename || 'court-bundle.pdf');
    const sourceDocs = [];
    let combinedInputBytes = 0;

    for (const documentId of documentIds) {
      const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!(await canAccessDocument(req, doc)) || !doc.matterId || !(await canAccessMatter(req, doc.matterId))) {
        await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: documentId, matterId: doc.matterId || '', clientId: await documentAuditClientId(doc, req), metadata: { reason: 'insufficient permissions', context: documentAuditContext(doc), route: 'document_tool_court_bundle_save' } }).catch(() => {});
        return res.status(403).json({ error: 'Document access denied' });
      }
      if (doc.matterId !== matterId) return res.status(400).json({ error: 'All PDFs must belong to the target matter' });
      if (doc.mimeType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF documents can be included' });

      const content = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
      combinedInputBytes += content.length;
      if (combinedInputBytes > MAX_MERGE_PDF_INPUT_BYTES) return res.status(413).json({ error: 'Selected PDFs exceed the 20 MB input limit' });
      sourceDocs.push({ ...doc, content });
    }

    const bundlePdf = await PDFLibDocument.create();
    const sourcePageCounts = [];
    try {
      for (const doc of sourceDocs) {
        const sourcePdf = await PDFLibDocument.load(doc.content, { ignoreEncryption: false });
        const copiedPages = await bundlePdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach(page => bundlePdf.addPage(page));
        sourcePageCounts.push(copiedPages.length);
      }
    } catch {
      return res.status(400).json({ error: 'One or more selected PDFs could not be read — they may be corrupt or encrypted' });
    }

    // Append the generation certificate as the LAST page now, before any front
    // matter is inserted at position 0. This keeps it trailing, leaves index
    // page-number math untouched, lets pagination number it automatically and
    // gives bookmark generation a stable page ref. The certificate is the
    // requested artifact, so a failure here aborts the bundle rather than
    // silently omitting it.
    let certificatePageRef = null;
    if (includeCertificate) {
      try {
        certificatePageRef = await generateBundleCertificate(req, { matter, sourceDocs, sourcePageCounts, includeCover, includeIndex, includeDividers, paginate, includeBookmarks, coverFields, outputFilename, bundlePdf });
      } catch {
        return res.status(400).json({ error: 'Could not generate the bundle certificate page' });
      }
    }

    // Insert divider pages before each source document (reverse order to avoid
    // shifting page index arithmetic). Each divider appears between the index
    // (or cover) and its corresponding source PDF.
    if (includeDividers) {
      for (let i = sourceDocs.length - 1; i >= 0; i--) {
        const doc = sourceDocs[i];
        const label = buildDividerLabel(doc, dividerLabels, documentLabels);
        const pos = sourcePageCounts.slice(0, i).reduce((a, b) => a + b, 0);
        try {
          await insertDividerPage(bundlePdf, pos, label, i + 1);
        } catch {
          return res.status(400).json({ error: 'Could not generate divider page' });
        }
      }
    }

    // Insert front matter so the cover is physical page 1 and the index follows
    // it: add the index at position 0 first, then the cover at position 0.
    if (includeIndex) {
      const startingPages = bundleIndexStartingPages(sourcePageCounts, { paginate, startNumber, coverPages: includeCover ? 1 : 0, includeDividers });
      const indexRows = sourceDocs.map((doc, i) => ({
        seq: i + 1,
        label: sanitizeIndexLabel(documentLabels[doc.id], doc.displayName || doc.name || doc.id),
        startPage: startingPages[i],
      }));
      try {
        await prependBundleIndexPage(bundlePdf, indexRows);
      } catch {
        return res.status(400).json({ error: 'Could not generate the bundle index page' });
      }
    }

    if (includeCover) {
      try {
        await prependBundleCoverPage(bundlePdf, coverFields);
      } catch {
        return res.status(400).json({ error: 'Could not generate the bundle cover page' });
      }
    }

    if (paginate) {
      const font = await bundlePdf.embedFont(StandardFonts.Helvetica);
      const fontSize = 10;
      const fontColor = rgb(0, 0, 0);
      const bottomMargin = 24;
      const pages = bundlePdf.getPages();
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const number = startNumber + i;
        const text = String(number);
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        const x = paginateTextX(width, textWidth, position);
        const y = bottomMargin + fontSize * 0.35;
        page.drawText(text, { x, y, size: fontSize, font, color: fontColor });
      }
    }

    // Optional PDF bookmarks / outline. Built against the final assembled layout
    // (cover, index and divider front/section matter already in place). Outline
    // construction never aborts bundle generation: on failure we fall back to a
    // valid PDF with no bookmarks (bookmarkCount stays 0).
    let bookmarkCount = 0;
    if (includeBookmarks) {
      try {
        const bookmarkEntries = buildBundleBookmarkEntries({ includeCover, includeIndex, includeDividers, sourceDocs, sourcePageCounts, dividerLabels, documentLabels });
        if (includeCertificate && certificatePageRef) bookmarkEntries.push({ title: 'Bundle Certificate', pageRef: certificatePageRef });
        bookmarkCount = addPdfOutlines(bundlePdf, bookmarkEntries);
      } catch {
        bookmarkCount = 0;
      }
    }

    let outputBuffer;
    try {
      outputBuffer = Buffer.from(await bundlePdf.save());
    } catch {
      return res.status(400).json({ error: 'Could not generate court bundle PDF' });
    }

    if (outputBuffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Output PDF exceeds the 50 MB limit' });

    const documentIdNew = genId('DOC');
    const cleanName = cleanDocumentName(outputFilename);
    const size = `${Math.max(1, Math.round(outputBuffer.length / 1024))} KB`;

    await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      documentIdNew,
      matterId,
      cleanName,
      cleanName,
      'PDF',
      'application/pdf',
      today(),
      size,
      outputBuffer,
      'document_tool',
      null,
      null,
      null,
      0,
      req.user.userId || '',
    ]);

    const resultDoc = await get(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentIdNew]);

    const pageCount = bundlePdf.getPageCount();
    const endNumber = paginate ? startNumber + pageCount - 1 : undefined;

    const metadata = {
      sourceDocumentIds: documentIds,
      sourceCount: sourceDocs.length,
      targetMatterId: matterId,
      outputDocumentId: documentIdNew,
      pageCount,
      paginate: !!paginate,
      inputBytes: combinedInputBytes,
      outputBytes: outputBuffer.length,
      filename: cleanName,
      clientVisible: false,
    };
    if (paginate) {
      metadata.startNumber = startNumber;
      metadata.endNumber = endNumber;
      metadata.position = position;
    }
    metadata.includeIndex = includeIndex;
    if (includeIndex) {
      metadata.indexPageCount = 1;
      metadata.labelCount = sourceDocs.filter(doc => Object.prototype.hasOwnProperty.call(documentLabels, doc.id)).length;
    }
    metadata.includeCover = includeCover;
    metadata.coverFieldCount = includeCover ? coverFieldCount : 0;
    metadata.includeDividers = includeDividers;
    metadata.dividerCount = includeDividers ? sourceDocs.length : 0;
    metadata.includeBookmarks = includeBookmarks;
    if (includeBookmarks) metadata.bookmarkCount = bookmarkCount;
    metadata.includeCertificate = includeCertificate;

    await recordAuditEvent(req, {
      action: 'document_tool_court_bundle_saved',
      entityType: 'document_tool',
      entityId: documentIdNew,
      matterId,
      clientId: await documentAuditClientId(resultDoc, req),
      metadata,
    }).catch(() => {});

    res.json(publicDocument(resultDoc));
  } catch {
    res.status(500).json({ error: 'Unable to save court bundle' });
  }
});

app.patch('/api/documents/:id', requireAdvocateOrAdmin, async (req, res) => {
  const doc = await get(`SELECT ${documentMetadataColumns()} FROM documents WHERE id=?`, [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.matterId && !(await canAccessMatter(req, doc.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Document access denied' });
  }
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
  const changedFields = [
    req.body.folderId !== undefined ? 'folderId' : null,
    req.body.displayName !== undefined ? 'displayName' : null,
  ].filter(Boolean);
  const updateContext = documentAuditContext(updated);
  const updateClientId = await documentAuditClientId(updated, req);
  if (changedFields.length) {
    await recordAuditEvent(req, {
      action: 'document_updated',
      entityType: 'document',
      entityId: req.params.id,
      matterId: updated.matterId || '',
      clientId: updateClientId,
      metadata: safeDocumentMetadata(updated, updateContext, 'document_update', { changedFields }),
    }).catch(() => {});
  }
  if (req.body.clientVisible !== undefined) {
    await recordAuditEvent(req, {
      action: 'document_visibility_updated',
      entityType: 'document',
      entityId: req.params.id,
      matterId: updated.matterId || '',
      clientId: updateClientId,
      metadata: safeDocumentMetadata(updated, updateContext, 'document_visibility_update', {
        oldClientVisible: Boolean(doc.clientVisible),
        newClientVisible: Boolean(updated.clientVisible),
      }),
    }).catch(() => {});
  }
  res.json(publicDocument(updated));
});
app.delete('/api/documents/:id', requireAdvocateOrAdmin, async (req, res) => {
  const doc = await get(`SELECT ${documentMetadataColumns()} FROM documents WHERE id=? AND deletedAt IS NULL`, [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.matterId && !(await canAccessMatter(req, doc.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_document_access', entityType: 'document', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Document access denied' });
  }
  await run("UPDATE documents SET deletedAt=? WHERE id=?", [new Date().toISOString(), req.params.id]);
  await logAudit(req, 'delete', 'document', req.params.id, `Soft-deleted document ${doc?.name || req.params.id}`);
  await recordAuditEvent(req, {
    action: 'document_deleted',
    entityType: 'document',
    entityId: req.params.id,
    matterId: doc.matterId || '',
    clientId: await documentAuditClientId(doc, req),
    metadata: safeDocumentMetadata(doc, documentAuditContext(doc), 'document_delete'),
  }).catch(() => {});
  res.json({ id: req.params.id, deleted: true });
});

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

async function invoicePaymentSummary(invoiceId, invoiceAmount = 0) {
  // PRODUCT-15O: voided payments (voidedAt set) are excluded from every active total.
  const row = await get('SELECT COALESCE(SUM(amount),0) amountPaid, COUNT(*) paymentCount, MAX(date) lastPaymentAt FROM payments WHERE invoiceId=? AND voidedAt IS NULL', [invoiceId]);
  const amountPaid = Number(row?.amountPaid || 0);
  const amount = Number(invoiceAmount || 0);
  return {
    amountPaid,
    balance: Math.max(amount - amountPaid, 0),
    paymentCount: Number(row?.paymentCount || 0),
    lastPaymentAt: row?.lastPaymentAt || '',
    isPaid: amount > 0 && amountPaid >= amount,
  };
}

async function nextReceiptNumber(year) {
  const yearKey = String(year || new Date().getFullYear());
  await run('INSERT OR IGNORE INTO receipt_sequences (year, lastSeq) VALUES (?, 0)', [yearKey]);
  await run('UPDATE receipt_sequences SET lastSeq=lastSeq+1 WHERE year=?', [yearKey]);
  const row = await get('SELECT lastSeq FROM receipt_sequences WHERE year=?', [yearKey]);
  const seq = Number(row?.lastSeq || 1);
  return `RCPT-${yearKey}-${String(seq).padStart(6, '0')}`;
}

async function backfillSeededReceiptNumbers() {
  const rows = await all('SELECT id, date, createdAt FROM payments WHERE receiptNumber IS NULL OR receiptNumber=""');
  if (!rows.length) return;
  const yearOf = row => {
    const source = row.date || row.createdAt || '';
    const match = /^(\d{4})/.exec(String(source));
    return match ? match[1] : String(new Date().getFullYear());
  };
  const ordered = rows.slice().sort((a, b) => {
    const ay = yearOf(a);
    const by = yearOf(b);
    if (ay !== by) return ay.localeCompare(by);
    return String(a.createdAt || a.date || '').localeCompare(String(b.createdAt || b.date || ''));
  });
  for (const row of ordered) {
    const number = await nextReceiptNumber(yearOf(row));
    await run('UPDATE payments SET receiptNumber=?, receiptIssuedAt=COALESCE(NULLIF(receiptIssuedAt,""), ?) WHERE id=?', [number, row.createdAt || row.date || new Date().toISOString(), row.id]);
  }
}

async function attachInvoiceSummary(invoice) {
  if (!invoice) return invoice;
  Object.assign(invoice, await invoicePaymentSummary(invoice.id, invoice.amount));
  return invoice;
}

async function attachInvoiceSummaries(invoices = []) {
  for (const invoice of invoices) await attachInvoiceSummary(invoice);
  return invoices;
}

const PAYMENT_PUBLIC_COLUMNS = 'id,invoiceId,matterId,clientId,amount,method,reference,date,note,proofId,createdBy,createdAt,receiptNumber,receiptIssuedAt,voidedAt,voidedBy,voidReason';

function maskInvoiceBilling(invoice) {
  invoice.amount = null;
  invoice.amountPaid = null;
  invoice.balance = null;
  invoice.paymentCount = null;
  invoice.lastPaymentAt = null;
  invoice.isPaid = null;
}

function publicPayment(row, { client = false } = {}) {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    matterId: row.matterId,
    clientId: row.clientId,
    amount: Number(row.amount || 0),
    method: row.method || '',
    reference: row.reference || '',
    date: row.date || '',
    note: client ? '' : row.note || '',
    proofId: row.proofId || '',
    createdAt: row.createdAt || '',
    receiptNumber: row.receiptNumber || '',
    receiptIssuedAt: row.receiptIssuedAt || '',
    // PRODUCT-15O: void state. Clients see only that a payment was voided (and when),
    // never the internal voidedBy/reason.
    voided: Boolean(row.voidedAt),
    voidedAt: row.voidedAt || '',
    ...(client ? {} : { voidedBy: row.voidedBy || '', voidReason: row.voidReason || '' }),
  };
}

app.get('/api/invoices', async (req, res) => {
  let invoices;
  if (req.user.role === 'client') {
    invoices = await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE i.clientId=? ORDER BY i.date DESC, i.number DESC`, [req.user.clientId || '']);
  } else if (req.user.role === 'advocate') {
    invoices = await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE m.assignedTo=? ORDER BY i.date DESC, i.number DESC`, [req.user.fullName || '']);
  } else {
    invoices = await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId ORDER BY i.date DESC, i.number DESC`);
  }
  await attachInvoiceSummaries(invoices);
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    for (const inv of invoices) maskInvoiceBilling(inv);
  }
  res.json(invoices);
});

app.get('/api/invoices/:id', async (req, res) => {
  const invoice = await invoiceWithDetails(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!(await canAccessInvoice(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_invoice_access', entityType: 'invoice', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Invoice access denied' });
  }
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    maskInvoiceBilling(invoice);
    if (invoice.items) {
      for (const item of invoice.items) { item.rate = null; item.amount = null; }
    }
  }
  res.json(invoice);
});
app.post('/api/invoices/generate', requireAdvocateOrAdmin, validate(generateInvoiceValidation), async (req, res) => {
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    return res.status(403).json({ error: 'Billing access restricted' });
  }
  try {
    const matter = await get('SELECT * FROM matters WHERE id=?', [req.body.matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matter.id))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matter.id, clientId: matter.clientId || '', metadata: { reason: 'insufficient permissions', route: 'invoice_generate' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }
    const date = today();
    const firmSettings = await getFirmSettings();
    const defaultInvoiceDueDays = normalizeDefaultInvoiceDueDays(firmSettings.defaultInvoiceDueDays);
    const dueDateOverrideProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'dueDate');
    let dueDate = addDays(defaultInvoiceDueDays);
    if (dueDateOverrideProvided) {
      const requestedDueDate = validIsoDateOnly(req.body.dueDate);
      if (!requestedDueDate) return res.status(400).json({ error: 'dueDate must be a valid YYYY-MM-DD date' });
      if (requestedDueDate < date) return res.status(400).json({ error: 'dueDate cannot be in the past' });
      dueDate = requestedDueDate;
    }
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
      const entries = await all('SELECT * FROM time_entries WHERE matterId=? AND billed=0 AND billable=1', [matter.id]);
      items = entries.map(t => ({ timeEntryId: t.id, date: t.date, description: t.description || t.activity || 'Legal Services', hours: Number(t.hours || 0), rate: Number(t.rate || 0), amount: Number(t.hours || 0) * Number(t.rate || 0) }));
      amount = items.reduce((sum, item) => sum + item.amount, 0);
    }
    if (amount <= 0) return res.status(400).json({ error: 'No billable amount found for this matter' });
    await run('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, matter.id, matter.clientId, number, date, amount, 'Outstanding', dueDate, source === 'fixed' ? 'Fixed fee invoice' : 'Unbilled time invoice', source]);
    for (const item of items) await run('INSERT INTO invoice_items (id,invoiceId,timeEntryId,date,description,hours,rate,amount) VALUES (?,?,?,?,?,?,?,?)', [genId('ITEM'), id, item.timeEntryId || '', item.date || date, item.description, item.hours, item.rate, item.amount]);
    if (source === 'hourly' && items.length) await run(`UPDATE time_entries SET billed=1 WHERE id IN (${items.map(() => '?').join(',')})`, items.map(i => i.timeEntryId));
    await run('UPDATE matters SET totalBilled=COALESCE(totalBilled,0)+? WHERE id=?', [amount, matter.id]);
    await logAudit(req, 'generate', 'invoice', id, `Generated invoice ${number} for matter ${matter.title}`);
    await recordAuditEvent(req, { action: 'invoice_generated', entityType: 'invoice', entityId: id, matterId: matter.id, clientId: matter.clientId, metadata: { invoiceId: id, number, amount, source, matterId: matter.id, clientId: matter.clientId, dueDate, defaultInvoiceDueDays, dueDateOverrideUsed: dueDateOverrideProvided } }).catch(() => {});
    res.json(await invoiceWithDetails(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
async function invoiceWithDetails(id) {
  const invoice = await get(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName, c.email clientEmail, c.phone clientPhone, c.contact clientAddress FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE i.id=?`, [id]);
  if (!invoice) return null;
  invoice.items = await all('SELECT * FROM invoice_items WHERE invoiceId=? ORDER BY date', [id]);
  return attachInvoiceSummary(invoice);
}
app.get('/api/invoices/:id', async (req, res) => { const invoice = await invoiceWithDetails(req.params.id); if (!invoice) return res.status(404).json({ error: 'Invoice not found' }); if (!(await canAccessInvoice(req, req.params.id))) return res.status(403).json({ error: 'Invoice access denied' }); res.json(invoice); });
app.get('/api/invoices/:id/payments', async (req, res) => {
  const invoice = await invoiceWithDetails(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!(await canAccessInvoice(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_invoice_access', entityType: 'invoice', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'invoice_payments_read' } }).catch(() => {});
    return res.status(403).json({ error: 'Invoice access denied' });
  }
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    await recordAuditEvent(req, { action: 'forbidden_invoice_payments', entityType: 'invoice', entityId: req.params.id, metadata: { reason: 'billing_visibility_disabled' } }).catch(() => {});
    return res.status(403).json({ error: 'Billing access restricted' });
  }
  const payments = await all(`SELECT ${PAYMENT_PUBLIC_COLUMNS} FROM payments WHERE invoiceId=? ORDER BY date DESC, createdAt DESC`, [req.params.id]);
  res.json({ invoice, payments: payments.map(row => publicPayment(row, { client: req.user.role === 'client' })) });
});
app.post('/api/invoices/:id/payments', async (req, res) => {
  if (!['admin', 'assistant'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or assistant access required' });
  const invoice = await invoiceWithDetails(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!(await canAccessInvoice(req, req.params.id))) return res.status(403).json({ error: 'Invoice access denied' });
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Payment amount must be greater than zero' });
  const summary = await invoicePaymentSummary(invoice.id, invoice.amount);
  if (amount - summary.balance > 0.0001) return res.status(400).json({ error: 'Payment exceeds invoice balance' });
  const date = String(req.body.date || today()).trim();
  if (!date) return res.status(400).json({ error: 'Payment date is required' });
  const method = String(req.body.method || '').trim().slice(0, 80);
  const reference = String(req.body.reference || '').trim().slice(0, 120);
  const note = String(req.body.note || '').trim().slice(0, 500);
  const proofId = String(req.body.proofId || '').trim();
  if (proofId) {
    const proof = await get('SELECT id,invoiceId,matterId,clientId,status FROM payment_proofs WHERE id=?', [proofId]);
    if (!proof || proof.invoiceId !== invoice.id || proof.matterId !== invoice.matterId || proof.clientId !== invoice.clientId) return res.status(400).json({ error: 'Payment proof does not match this invoice' });
    // PRODUCT-15I: a rejected proof must not be used to settle. Pending/Accepted may be used; payment recording itself remains deliberate.
    if (proof.status === 'Rejected') return res.status(400).json({ error: 'Rejected payment proof cannot be used to record a payment' });
  }
  const id = genId('PAY');
  const createdAt = new Date().toISOString();
  const receiptYear = /^(\d{4})/.exec(date)?.[1] || String(new Date().getFullYear());
  const receiptNumber = await nextReceiptNumber(receiptYear);
  const receiptIssuedAt = createdAt;
  await run('INSERT INTO payments (id,invoiceId,matterId,clientId,amount,method,reference,date,note,proofId,createdBy,createdAt,receiptNumber,receiptIssuedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    id,
    invoice.id,
    invoice.matterId,
    invoice.clientId || '',
    amount,
    method,
    reference,
    date,
    note,
    proofId,
    req.user.userId || '',
    createdAt,
    receiptNumber,
    receiptIssuedAt,
  ]);
  // PRODUCT-15I: link the proof back to the recorded payment (no status/balance mutation here).
  if (proofId) await run('UPDATE payment_proofs SET paymentId=? WHERE id=?', [id, proofId]);
  const updatedSummary = await invoicePaymentSummary(invoice.id, invoice.amount);
  const oldStatus = invoice.status || 'Outstanding';
  let newStatus = oldStatus;
  if (updatedSummary.isPaid && oldStatus !== 'Paid') newStatus = 'Paid';
  if (!updatedSummary.isPaid && oldStatus === 'Paid') newStatus = 'Outstanding';
  if (newStatus !== oldStatus) {
    await run('UPDATE invoices SET status=? WHERE id=?', [newStatus, invoice.id]);
    await logAudit(req, 'status', 'invoice', invoice.id, `Set invoice ${invoice.number || invoice.id} status to ${newStatus}`);
    await recordAuditEvent(req, {
      action: 'invoice_status_updated',
      entityType: 'invoice',
      entityId: invoice.id,
      matterId: invoice.matterId || '',
      clientId: invoice.clientId || '',
      metadata: { invoiceId: invoice.id, number: invoice.number || '', oldStatus, newStatus, reason: 'payment_recorded', paymentId: id, amountPaid: updatedSummary.amountPaid, balance: updatedSummary.balance },
    }).catch(() => {});
  }
  await logAudit(req, 'record_payment', 'invoice', invoice.id, `Recorded payment for invoice ${invoice.number || invoice.id}`);
  await recordAuditEvent(req, {
    action: 'invoice_payment_recorded',
    entityType: 'invoice',
    entityId: invoice.id,
    matterId: invoice.matterId || '',
    clientId: invoice.clientId || '',
    metadata: { invoiceId: invoice.id, paymentId: id, amount, method, date, proofLinked: Boolean(proofId), amountPaid: updatedSummary.amountPaid, balance: updatedSummary.balance, receiptNumber },
  }).catch(() => {});
  res.json({ invoice: await invoiceWithDetails(invoice.id), payment: publicPayment(await get(`SELECT ${PAYMENT_PUBLIC_COLUMNS} FROM payments WHERE id=?`, [id])) });
});
app.post('/api/invoices/:invoiceId/payments/:paymentId/void', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { invoiceId, paymentId } = req.params;
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Void reason is required' });
  const voidReason = reason.slice(0, 500);
  const invoice = await invoiceWithDetails(invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!(await canAccessInvoice(req, invoiceId))) return res.status(403).json({ error: 'Invoice access denied' });
  const payment = await get(`SELECT ${PAYMENT_PUBLIC_COLUMNS} FROM payments WHERE id=? AND invoiceId=?`, [paymentId, invoiceId]);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.voidedAt) return res.status(400).json({ error: 'Payment is already voided' });

  const previousSummary = await invoicePaymentSummary(invoice.id, invoice.amount);
  const previousStatus = invoice.status || 'Outstanding';
  const voidedAt = new Date().toISOString();
  await run('UPDATE payments SET voidedAt=?, voidedBy=?, voidReason=? WHERE id=? AND invoiceId=?', [voidedAt, req.user.userId || '', voidReason, payment.id, invoice.id]);

  let proofUnlinked = false;
  if (payment.proofId) {
    const proofResult = await run('UPDATE payment_proofs SET paymentId=? WHERE paymentId=?', ['', payment.id]);
    proofUnlinked = Number(proofResult?.changes || 0) > 0;
  }

  const updatedSummary = await invoicePaymentSummary(invoice.id, invoice.amount);
  let newStatus = previousStatus;
  if (previousStatus === 'Paid' && !updatedSummary.isPaid) newStatus = 'Outstanding';
  if (newStatus !== previousStatus) {
    await run('UPDATE invoices SET status=? WHERE id=?', [newStatus, invoice.id]);
    await logAudit(req, 'status', 'invoice', invoice.id, `Set invoice ${invoice.number || invoice.id} status to ${newStatus}`);
    await recordAuditEvent(req, {
      action: 'invoice_status_updated',
      entityType: 'invoice',
      entityId: invoice.id,
      matterId: invoice.matterId || '',
      clientId: invoice.clientId || '',
      metadata: { invoiceId: invoice.id, number: invoice.number || '', oldStatus: previousStatus, newStatus, reason: 'payment_voided', paymentId: payment.id, amountPaid: updatedSummary.amountPaid, balance: updatedSummary.balance },
    }).catch(() => {});
  }

  await logAudit(req, 'void_payment', 'invoice', invoice.id, `Voided payment for invoice ${invoice.number || invoice.id}`);
  await recordAuditEvent(req, {
    action: 'payment_voided',
    entityType: 'payment',
    entityId: payment.id,
    matterId: payment.matterId || invoice.matterId || '',
    clientId: payment.clientId || invoice.clientId || '',
    metadata: {
      invoiceId: invoice.id,
      paymentId: payment.id,
      amount: Number(payment.amount || 0),
      previousAmountPaid: previousSummary.amountPaid,
      newAmountPaid: updatedSummary.amountPaid,
      previousBalance: previousSummary.balance,
      newBalance: updatedSummary.balance,
      previousStatus,
      newStatus,
      proofUnlinked,
      reasonLength: voidReason.length,
    },
  }).catch(() => {});

  const voidedPayment = await get(`SELECT ${PAYMENT_PUBLIC_COLUMNS} FROM payments WHERE id=?`, [payment.id]);
  res.json({ invoice: await invoiceWithDetails(invoice.id), payment: publicPayment(voidedPayment) });
});
app.patch('/api/invoices/:id/status', requireAdmin, async (req, res) => {
  if (!['Paid', 'Outstanding', 'Overdue'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid invoice status' });
  const oldInvoice = await get('SELECT number,status,matterId,clientId FROM invoices WHERE id=?', [req.params.id]);
  if (!oldInvoice) return res.status(404).json({ error: 'Invoice not found' });
  const oldStatus = oldInvoice.status;
  await run('UPDATE invoices SET status=? WHERE id=?', [req.body.status, req.params.id]);
  const invoice = await invoiceWithDetails(req.params.id);
  await logAudit(req, 'status', 'invoice', req.params.id, `Set invoice ${invoice?.number || req.params.id} status to ${req.body.status}`);
  await recordAuditEvent(req, { action: 'invoice_status_updated', entityType: 'invoice', entityId: req.params.id, matterId: oldInvoice.matterId || '', clientId: oldInvoice.clientId || '', metadata: { invoiceId: req.params.id, number: oldInvoice.number || '', oldStatus, newStatus: req.body.status } }).catch(() => {});
  res.json(invoice);
});
app.delete('/api/invoices/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessInvoice(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_invoice_access', entityType: 'invoice', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Invoice access denied' });
  }
  const invoice = await get('SELECT * FROM invoices WHERE id=?', [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'Paid') return res.status(400).json({ error: 'Paid invoices cannot be deleted' });
  await run('DELETE FROM invoice_items WHERE invoiceId=?', [req.params.id]);
  await run('DELETE FROM invoices WHERE id=?', [req.params.id]);
  await logAudit(req, 'delete', 'invoice', req.params.id, `Deleted invoice ${invoice.number || req.params.id}`);
  await recordAuditEvent(req, { action: 'invoice_deleted', entityType: 'invoice', entityId: req.params.id, metadata: { number: invoice.number || '', status: invoice.status || '' } }).catch(() => {});
  res.json({ id: req.params.id, deleted: true });
});
app.get('/api/invoices/:id/pdf', async (req, res) => {
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    await recordAuditEvent(req, { action: 'forbidden_invoice_pdf', entityType: 'invoice', entityId: req.params.id, metadata: { reason: 'billing_visibility_disabled' } }).catch(() => {});
    return res.status(403).json({ error: 'Billing access restricted' });
  }
  if (!(await canAccessInvoice(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_invoice_access', entityType: 'invoice', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Invoice access denied' });
  }
  const invoice = await invoiceWithDetails(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  await recordAuditEvent(req, {
    action: 'invoice_pdf_downloaded',
    entityType: 'invoice',
    entityId: req.params.id,
    matterId: invoice.matterId || '',
    clientId: invoice.clientId || '',
    metadata: {
      invoiceId: req.params.id,
      number: invoice.number || '',
      status: invoice.status || '',
      amount: Number(invoice.amount || 0),
      billingVisible: true,
      route: 'invoice_pdf_download',
    },
  }).catch(() => {});
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
  if (invoice.dueDate) doc.font('Helvetica').fontSize(8).fillColor('#6B7280').text(`Payment due by ${invoice.dueDate}.`, 350, 204, { width: 195, align: 'right' });
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(11).text('Matter', 48, 220); doc.font('Helvetica').fontSize(10).text(`${invoice.reference || ''} ${invoice.matterTitle || ''}`.trim(), 48, 238, { width: 460 });
  const top = 282; doc.rect(48, top, 499, 24).fill('#F3F4F6'); doc.fillColor('#374151').font('Helvetica-Bold').fontSize(9); doc.text('Date', 56, top + 8); doc.text('Description', 132, top + 8); doc.text('Hours', 330, top + 8, { width: 42, align: 'right' }); doc.text('Rate', 382, top + 8, { width: 70, align: 'right' }); doc.text('Amount', 465, top + 8, { width: 70, align: 'right' });
  let y = top + 36; doc.font('Helvetica').fontSize(9).fillColor('#111827'); for (const item of invoice.items || []) { if (y > 690) { doc.addPage(); y = 60; } doc.text(item.date || invoice.date, 56, y); doc.text(item.description || 'Legal Services', 132, y, { width: 185 }); doc.text(Number(item.hours || 0).toFixed(item.hours ? 2 : 0), 330, y, { width: 42, align: 'right' }); doc.text(money(item.rate), 382, y, { width: 70, align: 'right' }); doc.text(money(item.amount), 465, y, { width: 70, align: 'right' }); y += 24; }
  y = Math.max(y + 24, 610); [['Subtotal', subtotal], ['VAT (16%)', vat], ['Total', total]].forEach(([label, value], i) => { doc.font(i === 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 2 ? 12 : 10).fillColor(i === 2 ? '#1B3A5C' : '#374151'); doc.text(label, 350, y + i * 22); doc.text(money(value), 440, y + i * 22, { width: 105, align: 'right' }); });
  // Optional firm tax / payment / footer-note block on the left column so it
  // clears the right-aligned totals; nothing renders when all fields are blank.
  drawFirmBillingBlock(doc, firm, 48, y, 288);
  doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text(`${firm.name || 'LexFlow Kenya'} | ${firm.address || 'Nairobi, Kenya'} | ${firm.email || 'accounts@lexflow.co.ke'} | ${firm.phone || '+254 700 123456'}`, 48, 760, { align: 'center', width: 499 });
  doc.end();
});

app.get('/api/invoices/:invoiceId/payments/:paymentId/receipt.pdf', async (req, res) => {
  const { invoiceId, paymentId } = req.params;
  if (!(await canAccessInvoice(req, invoiceId))) {
    await recordAuditEvent(req, { action: 'forbidden_invoice_access', entityType: 'invoice', entityId: invoiceId, metadata: { reason: 'insufficient permissions', route: 'payment_receipt_pdf' } }).catch(() => {});
    return res.status(403).json({ error: 'Invoice access denied' });
  }
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    await recordAuditEvent(req, { action: 'forbidden_payment_receipt', entityType: 'payment', entityId: paymentId, metadata: { invoiceId, reason: 'billing_visibility_disabled' } }).catch(() => {});
    return res.status(403).json({ error: 'Billing access restricted' });
  }
  const invoice = await invoiceWithDetails(invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const payment = await get(`SELECT ${PAYMENT_PUBLIC_COLUMNS} FROM payments WHERE id=? AND invoiceId=?`, [paymentId, invoiceId]);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.voidedAt) return res.status(409).json({ error: 'Payment receipt is voided' });
  if (!payment.receiptNumber) return res.status(404).json({ error: 'Receipt not available for this payment' });
  const receivedBy = payment.createdBy ? await get('SELECT fullName FROM users WHERE id=?', [payment.createdBy]) : null;
  await recordAuditEvent(req, {
    action: 'payment_receipt_downloaded',
    entityType: 'payment',
    entityId: payment.id,
    matterId: invoice.matterId || '',
    clientId: invoice.clientId || '',
    metadata: {
      paymentId: payment.id,
      invoiceId,
      matterId: invoice.matterId || '',
      clientId: invoice.clientId || '',
      receiptNumber: payment.receiptNumber,
      amount: Number(payment.amount || 0),
      route: 'payment_receipt_pdf',
    },
  }).catch(() => {});
  const firm = await getFirmSettings();
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${payment.receiptNumber}.pdf"`);
  doc.pipe(res);
  doc.rect(48, 42, 52, 52).fill(firm.primaryColor || '#1B3A5C');
  if (firm.logo && String(firm.logo).startsWith('data:image')) {
    try { doc.image(Buffer.from(String(firm.logo).split(',').pop(), 'base64'), 52, 46, { fit: [44, 44] }); } catch { doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('LF', 64, 60); }
  } else {
    doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('LF', 64, 60);
  }
  doc.fillColor('#111827').fontSize(22).text(firm.name || 'LexFlow Kenya', 112, 46);
  doc.fontSize(10).fillColor('#6B7280').font('Helvetica').text(firm.address || 'Kenyan Law Practice Management', 112, 74);
  doc.fillColor('#1B3A5C').fontSize(24).font('Helvetica-Bold').text('PAYMENT RECEIPT', 320, 48, { align: 'right', width: 227 });
  doc.moveTo(48, 112).lineTo(547, 112).strokeColor('#E5E7EB').stroke();
  doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text('Received From', 48, 132);
  doc.font('Helvetica').fillColor('#374151').text(invoice.clientName || 'Client', 48, 150).text(invoice.clientAddress || invoice.clientEmail || invoice.clientPhone || 'Address on file', 48, 166, { width: 230 });
  [['Receipt #', payment.receiptNumber], ['Payment Date', payment.date || ''], ['Issued', (payment.receiptIssuedAt || '').slice(0, 10)], ['Method', payment.method || '-']].forEach(([label, value], i) => {
    const y = 132 + i * 18;
    doc.font('Helvetica-Bold').fillColor('#6B7280').text(label, 350, y);
    doc.font('Helvetica').fillColor('#111827').text(String(value || ''), 440, y, { width: 105, align: 'right' });
  });
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(11).text('Matter', 48, 220);
  doc.font('Helvetica').fontSize(10).text(`${invoice.reference || ''} ${invoice.matterTitle || ''}`.trim() || '-', 48, 238, { width: 460 });
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(11).text('Invoice', 48, 266);
  doc.font('Helvetica').fontSize(10).text(`${invoice.number || invoice.id} (Total ${money(Number(invoice.amount || 0))})`, 48, 284, { width: 460 });
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(11).text('Reference', 48, 312);
  doc.font('Helvetica').fontSize(10).text(payment.reference || '-', 48, 330, { width: 460 });
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(11).text('Received By', 48, 358);
  doc.font('Helvetica').fontSize(10).text(receivedBy?.fullName || 'Firm', 48, 376, { width: 460 });
  const summaryTop = 420;
  doc.rect(48, summaryTop, 499, 24).fill('#F3F4F6');
  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(9).text('Description', 56, summaryTop + 8).text('Amount Received', 380, summaryTop + 8, { width: 160, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Payment against invoice ${invoice.number || invoice.id}`, 56, summaryTop + 36, { width: 320 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1B3A5C').text(money(Number(payment.amount || 0)), 380, summaryTop + 36, { width: 160, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#374151').text('This is a payment receipt issued against the invoice referenced above. It does not replace or alter the invoice tax treatment.', 48, summaryTop + 90, { width: 499 });
  drawFirmBillingBlock(doc, firm, 48, summaryTop + 126, 499);
  doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text(`${firm.name || 'LexFlow Kenya'} | ${firm.address || 'Nairobi, Kenya'} | ${firm.email || 'accounts@lexflow.co.ke'} | ${firm.phone || '+254 700 123456'}`, 48, 760, { align: 'center', width: 499 });
  doc.end();
});

app.get('/api/client/dashboard', async (req, res) => {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Client access required' });
  const data = await getClientDashboardData(req.user.clientId || '', req);
  await attachInvoiceSummaries(data.invoices || []);
  data.invoicePayments = (await all(`SELECT ${PAYMENT_PUBLIC_COLUMNS} FROM payments WHERE clientId=? ORDER BY date DESC, createdAt DESC`, [req.user.clientId || ''])).map(row => publicPayment(row, { client: true }));
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
  await recordAuditEvent(req, { action: 'payment_proof_uploaded', entityType: 'payment_proof', entityId: id, matterId, clientId: req.user.clientId || '', metadata: { paymentProofId: id, invoiceId: invoiceId || '', matterId, method, reference, amount: Number(amount || 0) } }).catch(() => {});
  res.json(await get('SELECT id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,createdAt,status,reviewedAt,reviewNote,paymentId FROM payment_proofs WHERE id=?', [id]));
});

// PRODUCT-15I: payment-proof review queue + safe attachment download + accept/reject review.
const PAYMENT_PROOF_REVIEW_STATUSES = ['Accepted', 'Rejected'];
const PAYMENT_PROOF_FILTER_STATUSES = ['Pending', 'Accepted', 'Rejected'];
const SAFE_PROOF_DOWNLOAD_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/pdf']);

app.get('/api/payment-proofs', requireStaff, async (req, res) => {
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    await recordAuditEvent(req, { action: 'forbidden_payment_proof_queue', entityType: 'payment_proof', metadata: { reason: 'billing_visibility_disabled' } }).catch(() => {});
    return res.status(403).json({ error: 'Billing access restricted' });
  }
  const requested = String(req.query.status || 'All').trim();
  const statusFilter = requested === 'All' ? null : (PAYMENT_PROOF_FILTER_STATUSES.includes(requested) ? requested : null);
  if (requested !== 'All' && !statusFilter) return res.status(400).json({ error: 'Invalid status filter' });
  const conditions = [];
  const params = [];
  if (statusFilter) { conditions.push('pp.status=?'); params.push(statusFilter); }
  // Advocates only see proofs for matters assigned to them; admin/assistant see all.
  if (req.user.role === 'advocate') { conditions.push('m.assignedTo=?'); params.push(req.user.fullName || ''); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await all(`SELECT pp.id, pp.invoiceId, pp.matterId, pp.clientId, pp.method, pp.reference, pp.amount, pp.note, pp.fileName, pp.mimeType, pp.size, pp.createdAt, pp.status, pp.reviewedBy, pp.reviewedAt, pp.reviewNote, pp.paymentId,
      i.number invoiceNumber, i.status invoiceStatus, i.dueDate invoiceDueDate, i.amount invoiceAmount,
      m.title matterTitle, m.reference matterReference,
      c.name clientName,
      (SELECT u.fullName FROM users u WHERE u.id=pp.reviewedBy) reviewedByName,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoiceId=pp.invoiceId AND p.voidedAt IS NULL),0) invoiceAmountPaid,
      CASE WHEN pp.content IS NULL THEN 0 ELSE 1 END hasAttachment
    FROM payment_proofs pp
    LEFT JOIN invoices i ON i.id=pp.invoiceId
    LEFT JOIN matters m ON m.id=pp.matterId
    LEFT JOIN clients c ON c.id=pp.clientId
    ${where}
    ORDER BY pp.createdAt DESC`, params);
  // Never return BLOB content; expose only review-relevant metadata.
  const proofs = rows.map(row => {
    const invoiceAmount = Number(row.invoiceAmount || 0);
    const invoiceAmountPaid = Number(row.invoiceAmountPaid || 0);
    return {
      id: row.id,
      invoiceId: row.invoiceId || '',
      invoiceNumber: row.invoiceNumber || '',
      invoiceStatus: row.invoiceStatus || '',
      invoiceDueDate: row.invoiceDueDate || '',
      invoiceAmount,
      invoiceAmountPaid,
      invoiceBalance: row.invoiceId ? Math.max(invoiceAmount - invoiceAmountPaid, 0) : 0,
      matterId: row.matterId || '',
      matterTitle: row.matterTitle || '',
      matterReference: row.matterReference || '',
      clientId: row.clientId || '',
      clientName: row.clientName || '',
      method: row.method || '',
      reference: row.reference || '',
      amount: Number(row.amount || 0),
      note: row.note || '',
      fileName: row.fileName || '',
      mimeType: row.mimeType || '',
      size: row.size || '',
      hasAttachment: Number(row.hasAttachment || 0) === 1,
      createdAt: row.createdAt || '',
      status: row.status || 'Pending',
      reviewedBy: row.reviewedBy || '',
      reviewedByName: row.reviewedByName || '',
      reviewedAt: row.reviewedAt || '',
      reviewNote: row.reviewNote || '',
      paymentId: row.paymentId || '',
    };
  });
  const pendingCount = (statusFilter && statusFilter !== 'Pending') ? null : proofs.filter(p => p.status === 'Pending').length;
  res.json({ proofs, pendingCount });
});

app.get('/api/payment-proofs/:id/attachment', requireStaff, async (req, res) => {
  const proof = await get('SELECT id,matterId,clientId,fileName,mimeType,content FROM payment_proofs WHERE id=?', [req.params.id]);
  if (!proof) return res.status(404).json({ error: 'Payment proof not found' });
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    await recordAuditEvent(req, { action: 'forbidden_payment_proof_attachment', entityType: 'payment_proof', entityId: proof.id, matterId: proof.matterId || '', clientId: proof.clientId || '', metadata: { reason: 'billing_visibility_disabled' } }).catch(() => {});
    return res.status(403).json({ error: 'Billing access restricted' });
  }
  if (!(await canAccessMatter(req, proof.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_payment_proof_attachment', entityType: 'payment_proof', entityId: proof.id, matterId: proof.matterId || '', clientId: proof.clientId || '', metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Payment proof access denied' });
  }
  if (!proof.content) return res.status(404).json({ error: 'No attachment for this payment proof' });
  // Do not trust the uploaded MIME blindly: only serve a known-safe content type, else octet-stream.
  const declared = String(proof.mimeType || '').toLowerCase();
  const contentType = SAFE_PROOF_DOWNLOAD_MIME.has(declared) ? declared : 'application/octet-stream';
  const safeName = (proof.fileName ? String(proof.fileName).replace(/[^\w .-]/g, '_') : '') || `payment-proof-${proof.id}`;
  await recordAuditEvent(req, { action: 'payment_proof_attachment_downloaded', entityType: 'payment_proof', entityId: proof.id, matterId: proof.matterId || '', clientId: proof.clientId || '', metadata: { paymentProofId: proof.id, matterId: proof.matterId || '', clientId: proof.clientId || '', fileName: safeName } }).catch(() => {});
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.send(Buffer.isBuffer(proof.content) ? proof.content : Buffer.from(proof.content || ''));
});

app.patch('/api/payment-proofs/:id/review', async (req, res) => {
  if (!['admin', 'assistant'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or assistant access required' });
  const status = String(req.body.status || '').trim();
  if (!PAYMENT_PROOF_REVIEW_STATUSES.includes(status)) return res.status(400).json({ error: 'status must be Accepted or Rejected' });
  const reviewNote = String(req.body.reviewNote || '').trim().slice(0, 500);
  const proof = await get('SELECT id,invoiceId,matterId,clientId,status FROM payment_proofs WHERE id=?', [req.params.id]);
  if (!proof) return res.status(404).json({ error: 'Payment proof not found' });
  const reviewedAt = new Date().toISOString();
  // Review only: no payment is created and no invoice.status/balance is mutated here.
  await run('UPDATE payment_proofs SET status=?, reviewedBy=?, reviewedAt=?, reviewNote=? WHERE id=?', [status, req.user.userId || '', reviewedAt, reviewNote, proof.id]);
  await logAudit(req, 'review', 'payment_proof', proof.id, `Marked payment proof ${status}`);
  await recordAuditEvent(req, { action: 'payment_proof_reviewed', entityType: 'payment_proof', entityId: proof.id, matterId: proof.matterId || '', clientId: proof.clientId || '', metadata: { paymentProofId: proof.id, invoiceId: proof.invoiceId || '', matterId: proof.matterId || '', clientId: proof.clientId || '', status, previousStatus: proof.status || 'Pending', reviewNote } }).catch(() => {});
  res.json(await get('SELECT id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,createdAt,status,reviewedBy,reviewedAt,reviewNote,paymentId FROM payment_proofs WHERE id=?', [proof.id]));
});

app.get('/api/search', requireStaff, async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  if (q === '%%') return res.json([]);
  if (req.user.role === 'advocate') {
    const name = req.user.fullName || '';
    const matters = await all(`SELECT m.id,m.title,m.reference,c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.assignedTo=? AND (m.title LIKE ? OR m.reference LIKE ? OR c.name LIKE ?) LIMIT 5`, [name, q, q, q]);
    const clients = await all(`SELECT DISTINCT c.id,c.name,c.email,c.phone FROM clients c INNER JOIN matters m ON m.clientId=c.id WHERE m.assignedTo=? AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?) LIMIT 5`, [name, q, q, q]);
    const tasks = await all(`SELECT t.id,t.title,t.assignee,t.matterId FROM tasks t LEFT JOIN matters m ON m.id=t.matterId WHERE (t.assignee=? OR m.assignedTo=?) AND (t.title LIKE ? OR t.assignee LIKE ?) LIMIT 5`, [name, name, q, q]);
    const invoices = await all(`SELECT i.id,i.number,i.description,i.status,i.matterId FROM invoices i INNER JOIN matters m ON m.id=i.matterId WHERE m.assignedTo=? AND (i.number LIKE ? OR i.description LIKE ? OR i.status LIKE ?) LIMIT 5`, [name, q, q, q]);
    const appearances = await all(`SELECT a.id,a.title,a.date,a.time,a.type,a.location,a.attorney,a.matterId FROM appearances a LEFT JOIN matters m ON m.id=a.matterId WHERE (a.attorney=? OR m.assignedTo=?) AND (a.title LIKE ? OR a.location LIKE ? OR a.type LIKE ?) LIMIT 5`, [name, name, q, q, q]);
    const documents = await all(`SELECT d.id,d.displayName,d.name,d.type,d.matterId FROM documents d INNER JOIN matters m ON m.id=d.matterId WHERE m.assignedTo=? AND d.deletedAt IS NULL AND (d.displayName LIKE ? OR d.name LIKE ?) LIMIT 5`, [name, q, q]);
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
  // admin/assistant - no scoping
  const matters = await all(`SELECT m.id,m.title,m.reference,c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.title LIKE ? OR m.reference LIKE ? OR c.name LIKE ? LIMIT 5`, [q, q, q]);
  const clients = await all('SELECT id,name,email,phone FROM clients WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 5', [q, q, q]);
  const tasks = await all(`SELECT id,title,assignee,matterId FROM tasks WHERE title LIKE ? OR assignee LIKE ? LIMIT 5`, [q, q]);
  const invoices = await all(`SELECT id,number,description,status,matterId FROM invoices WHERE number LIKE ? OR description LIKE ? OR status LIKE ? LIMIT 5`, [q, q, q]);
  const appearances = await all(`SELECT id,title,date,time,type,location,attorney,matterId FROM appearances WHERE title LIKE ? OR location LIKE ? OR type LIKE ? LIMIT 5`, [q, q, q]);
  const documents = await all(`SELECT id,displayName,name,type,matterId FROM documents WHERE deletedAt IS NULL AND (displayName LIKE ? OR name LIKE ?) LIMIT 5`, [q, q]);
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
app.get('/api/exports/:type.:format', requireStaff, async (req, res) => {
  const exportType = req.params.type;
  const format = req.params.format;
  if (!['itax', 'matters'].includes(exportType)) return res.status(400).json({ error: 'Invalid export type' });
  const billingVisible = await isBillingVisibleFor(req);
  const advocateName = req.user?.fullName || '';
  let rows;
  if (exportType === 'itax') {
    rows = req.user?.role === 'advocate'
      ? await all(`SELECT i.number,i.date,c.name client,i.amount,i.status FROM invoices i JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE m.assignedTo=?`, [advocateName])
      : await all(`SELECT i.number,i.date,c.name client,i.amount,i.status FROM invoices i LEFT JOIN clients c ON c.id=i.clientId`);
    if (!billingVisible) rows = rows.map(r => ({ ...r, amount: null }));
  } else {
    rows = req.user?.role === 'advocate'
      ? await all(`SELECT m.reference,m.title,c.name client,m.practiceArea,m.stage,m.totalBilled FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.assignedTo=?`, [advocateName])
      : await all(`SELECT m.reference,m.title,c.name client,m.practiceArea,m.stage,m.totalBilled FROM matters m LEFT JOIN clients c ON c.id=m.clientId`);
    if (!billingVisible) rows = rows.map(r => ({ ...r, totalBilled: null }));
  }
  if (format === 'pdf') {
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${exportType}-report.pdf"`);
    doc.pipe(res);
    doc.fontSize(18).text(`${exportType.toUpperCase()} Report`);
    rows.forEach(r => doc.fontSize(10).text(Object.values(r).join(' | ')));
    doc.end();
  } else {
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', `attachment; filename="${exportType}-report.xls"`);
    res.send(rows.map(r => Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'));
  }
  await recordAuditEvent(req, { action: 'export_downloaded', entityType: 'export', entityId: `${exportType}.${format}`, metadata: { exportType, format, recordCount: rows.length } }).catch(() => {});
});

// Health check endpoint — public, no auth, no sensitive data
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.json({
    status: 'ok',
    service: 'lexflow-api',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Initialize database when module is loaded (required by tests and by server start)
const dbReady = initDb().catch(err => {
  console.error('Database initialisation failed', err);
  if (require.main === module) process.exit(1);
});

module.exports = { app, config, dbReady };

if (require.main === module) {
  dbReady.then(() => {
    app.listen(config.PORT, () => {
      console.log(`LexFlow Kenya server running at http://localhost:${config.PORT}`);
      startReminderJobs(getFirmSettings);
    });
  }).catch(err => {
    console.error('Database initialisation failed', err);
    process.exit(1);
  });
}
