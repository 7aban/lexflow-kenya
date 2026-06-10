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
// LOCAL-PILOT-FIX-1: pick the JSON body limit per path BEFORE parsing. The
// previous global 1mb parser ran first on every request, so the larger limit
// mounted at /api/documents never took effect — and the actual upload routes
// (/api/matters/:id/documents, /api/document-requests/:id/respond,
// /api/hr/documents) are not under /api/documents anyway, capping uploads at
// ~750 KB after base64 inflation and returning Express's HTML 413 page.
const UPLOAD_BODY_PATHS = [
  /^\/api\/documents(\/|$)/,
  /^\/api\/matters\/[^/]+\/documents(\/|$)/,
  /^\/api\/document-requests\/[^/]+\/respond$/,
  /^\/api\/hr\/documents(\/|$)/,
];
const isUploadBodyPath = requestPath => UPLOAD_BODY_PATHS.some(pattern => pattern.test(requestPath));
const standardJsonParser = express.json({ limit: config.JSON_BODY_LIMIT });
const uploadJsonParser = express.json({ limit: config.UPLOAD_BODY_LIMIT });
app.use((req, res, next) => (isUploadBodyPath(req.path) ? uploadJsonParser : standardJsonParser)(req, res, next));
// Clear JSON 413 instead of Express's default HTML error page. File-type and
// visibility policy are still enforced by the individual routes.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: isUploadBodyPath(req.path)
        ? `File is too large. The maximum upload size is ${config.UPLOAD_MAX_FILE_MB} MB.`
        : 'Request body is too large.',
      code: 'payload_too_large',
    });
  }
  return next(err);
});

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

const DEFAULT_MODULE_SETTINGS = {
  retainerManagement: false,
  kycCdd: false,
  corporateAuthority: false,
  retainerLedger: false,
  scopeVariation: false,
  clientTasks: false,
  advancedCompliance: false,
};

const ALLOWED_MODULE_KEYS = new Set(Object.keys(DEFAULT_MODULE_SETTINGS));

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
  moduleSettings: { ...DEFAULT_MODULE_SETTINGS },
};

const ALLOWED_RETAINER_STATUSES = new Set(['not_started', 'draft', 'sent', 'signed', 'declined', 'terminated']);
const ALLOWED_RETAINER_ENGAGEMENT_TYPES = new Set(['advisory', 'litigation', 'conveyancing', 'corporate', 'employment', 'family', 'criminal', 'other']);

// RET-31E: matter fee plan enums (planning/record only; no billing computation).
const ALLOWED_FEE_PLAN_TYPES = new Set(['fixed', 'hourly', 'capped', 'retainer', 'contingency', 'pro_bono', 'mixed', 'other']);
const ALLOWED_FEE_PLAN_STATUSES = new Set(['draft', 'proposed', 'approved', 'superseded', 'cancelled']);
const ALLOWED_FEE_PLAN_BILLING_FREQUENCIES = new Set(['upfront', 'monthly', 'milestone', 'on_completion', 'as_incurred', 'other']);
const ALLOWED_FEE_PLAN_VAT_TREATMENTS = new Set(['exclusive', 'inclusive', 'exempt', 'not_applicable']);
const ALLOWED_FEE_PLAN_DISBURSEMENTS_TREATMENTS = new Set(['included', 'billed_separately', 'estimated', 'not_applicable', 'other']);

// RET-31F: retainer ledger enums (planning/record ledger only; no trust accounting).
const ALLOWED_LEDGER_ENTRY_TYPES = new Set(['deposit', 'fee_application', 'refund', 'adjustment']);
const ALLOWED_LEDGER_DIRECTIONS = new Set(['credit', 'debit']);
// Fixed direction per entry type ('adjustment' allows either).
const LEDGER_REQUIRED_DIRECTION = { deposit: 'credit', refund: 'debit', fee_application: 'debit' };

// RET-31G: client KYC/CDD enums (metadata-only; no document upload, no screening).
const ALLOWED_KYC_STATUSES = new Set(['not_started', 'pending', 'verified', 'expired', 'rejected']);
const ALLOWED_KYC_CLIENT_CATEGORIES = new Set(['individual', 'company', 'organisation', 'government', 'other']);
const ALLOWED_KYC_RISK_LEVELS = new Set(['low', 'medium', 'high']);
const ALLOWED_KYC_PEP_STATUSES = new Set(['unknown', 'not_pep', 'pep']);
const ALLOWED_KYC_SANCTIONS_STATUSES = new Set(['not_checked', 'clear', 'flagged']);
const ALLOWED_AUTHORITY_STATUSES = new Set(['not_required', 'pending', 'confirmed', 'expired', 'rejected']);
const ALLOWED_AUTHORITY_BASIS = new Set(['director_resolution', 'board_resolution', 'power_of_attorney', 'letter_of_authority', 'mandate', 'other']);

// RET-31I: retainer lifecycle event enums (append-only record; no side-effect mutations).
const ALLOWED_LIFECYCLE_EVENT_TYPES = new Set(['scope_variation', 'suspension', 'resumption', 'termination', 'closure']);
const ALLOWED_LIFECYCLE_STATUSES = new Set(['recorded', 'pending', 'approved', 'completed', 'cancelled']);

// KENYA-32B: legal deadline rule enums (advocate-verified data; NOT hard-coded legal periods).
const ALLOWED_LEGAL_RULE_TYPES = new Set(['limitation', 'statutory_recurring', 'procedural']);
const ALLOWED_LEGAL_RULE_PERIOD_UNITS = new Set(['days', 'months', 'years']);
const ALLOWED_LEGAL_RULE_COMPUTATION_MODES = new Set(['calendar']);

// KENYA-32C: persisted deadline suggestion statuses (draft -> confirmed/cancelled, no other transitions).
const ALLOWED_LEGAL_SUGGESTION_STATUSES = new Set(['draft', 'confirmed', 'cancelled']);

// KENYA-32D: advocate/admin legal rule review statuses (review metadata only; no computation change).
const ALLOWED_LEGAL_RULE_REVIEW_STATUSES = new Set(['pending', 'reviewed', 'needs_update']);

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

function parseModuleSettingsJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function normalizeModuleSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'moduleSettings must be an object' };
  const unknownKeys = Object.keys(input).filter(key => !ALLOWED_MODULE_KEYS.has(key));
  if (unknownKeys.length) return { error: `Unknown module setting key: ${unknownKeys[0]}` };
  const normalized = {};
  for (const key of ALLOWED_MODULE_KEYS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') {
      if (input[key] === 1 || input[key] === 0) {
        normalized[key] = Boolean(input[key]);
      } else {
        return { error: `Module setting "${key}" must be a boolean value` };
      }
    } else {
      normalized[key] = input[key];
    }
  }
  return { value: normalized };
}

function resolveModuleSettings(stored) {
  const parsed = parseModuleSettingsJson(stored);
  if (!parsed) return { ...DEFAULT_MODULE_SETTINGS };
  const valid = {};
  for (const key of ALLOWED_MODULE_KEYS) {
    if (typeof parsed[key] === 'boolean') {
      valid[key] = parsed[key];
    }
  }
  return { ...DEFAULT_MODULE_SETTINGS, ...valid };
}

async function isModuleEnabled(moduleKey) {
  if (!ALLOWED_MODULE_KEYS.has(moduleKey)) return false;
  const settings = await getFirmSettings();
  return Boolean(settings.moduleSettings?.[moduleKey]);
}

async function requireEnabledModule(req, res, moduleKey, label) {
  if (!(await isModuleEnabled(moduleKey))) {
    return res.status(403).json({ error: 'feature_disabled', message: `${label} is not enabled for this firm.` });
  }
  return true;
}

const HR_STAFF_ROLES = new Set(['admin', 'advocate', 'assistant']);
const HR_EMPLOYMENT_TYPES = new Set(['advocate', 'associate', 'pupil', 'clerk', 'assistant', 'admin', 'consultant', 'intern', 'other']);
const HR_STATUSES = new Set(['active', 'on_leave', 'suspended', 'exited']);
const HR_PROFILE_FIELDS = [
  'jobTitle',
  'department',
  'practiceTeam',
  'employmentType',
  'startDate',
  'contractEndDate',
  'supervisorUserId',
  'workEmail',
  'workPhone',
  'emergencyContactName',
  'emergencyContactPhone',
  'hrStatus',
  'adminNotes',
];
const ALLOWED_LEAVE_TYPES = new Set(['annual','sick','compassionate','maternity','paternity','study_exam','unpaid','other']);
const ALLOWED_LEAVE_STATUSES = new Set(['pending','approved','rejected','cancelled']);
const HR_AUDIT_SENSITIVE_FIELDS = new Set(['adminNotes', 'emergencyContactName', 'emergencyContactPhone']);
const HR_FIELD_LIMITS = {
  jobTitle: 120,
  department: 120,
  practiceTeam: 120,
  employmentType: 40,
  startDate: 20,
  contractEndDate: 20,
  supervisorUserId: 80,
  workEmail: 254,
  workPhone: 80,
  emergencyContactName: 160,
  emergencyContactPhone: 80,
  hrStatus: 40,
  adminNotes: 2000,
};

// HR-29E: contracts and HR document records (admin-only, separate from matter documents)
const HR_DOCUMENT_TYPES = new Set(['contract', 'id', 'kra_pin', 'practising_certificate', 'academic_certificate', 'leave_support', 'other']);
const HR_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const HR_CONTRACT_TYPES = new Set(['permanent', 'fixed_term', 'consultancy', 'internship', 'pupilage', 'secondment', 'other']);
const HR_CONTRACT_STATUSES = new Set(['active', 'expired', 'terminated', 'superseded']);
const MAX_HR_DOCUMENT_BYTES = 10 * 1024 * 1024;
const HR_DOCUMENT_TITLE_MAX = 160;
const HR_DOCUMENT_FILENAME_MAX = 220;
const HR_CONTRACT_NOTES_MAX = 2000;
const HR_CONTRACT_DATE_FIELDS = ['startDate', 'endDate', 'probationEndDate', 'renewalDate'];

// HR-29F: staff offboarding workflow (admin-only; orchestrates matter-reassignment review + deactivation)
const HR_OFFBOARDING_STATUSES = new Set(['open', 'in_progress', 'completed', 'cancelled']);
const HR_OFFBOARDING_REASONS = new Set(['resignation', 'termination', 'end_of_contract', 'retirement', 'redundancy', 'transfer', 'other']);
const HR_OFFBOARDING_CHECKLIST_STATUSES = new Set(['pending', 'in_progress', 'done', 'skipped', 'na']);
const HR_OFFBOARDING_NOTES_MAX = 2000;
const HR_OFFBOARDING_EXITTYPE_MAX = 60;
// Standard checklist seeded on case creation (itemKey -> label). Order preserved.
const HR_OFFBOARDING_CHECKLIST_TEMPLATE = [
  ['review_assigned_matters', 'Review assigned matters'],
  ['reassign_active_matters', 'Reassign active matters'],
  ['review_pending_leave', 'Review pending leave'],
  ['review_contracts_documents', 'Review contracts and HR documents'],
  ['deactivate_account', 'Deactivate account'],
  ['return_firm_property', 'Return firm property'],
  ['final_dues_note', 'Final dues note'],
  ['close_hr_file', 'Close HR file'],
];
// Matter stages that count as "active" for offboarding (mirrors dashboard.js active-matter logic).
const HR_OFFBOARDING_INACTIVE_STAGES = ['Closed', 'On Hold'];

function isIsoDateText(value) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeHrText(field, value) {
  if (value === undefined) return { supplied: false };
  if (value === null) return { supplied: true, value: '' };
  if (typeof value !== 'string') return { supplied: true, error: `${field} must be a string` };
  const text = value.trim();
  const max = HR_FIELD_LIMITS[field] || 200;
  if (text.length > max) return { supplied: true, error: `${field} must not exceed ${max} characters` };
  return { supplied: true, value: text };
}

function validateHrProfilePayload(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(input).filter(field => !HR_PROFILE_FIELDS.includes(field));
  if (unknown.length) return { error: `Unsupported HR profile field: ${unknown[0]}` };

  const value = {};
  const changedFields = [];
  for (const field of HR_PROFILE_FIELDS) {
    const normalized = normalizeHrText(field, input[field]);
    if (normalized.error) return { error: normalized.error };
    if (normalized.supplied) {
      value[field] = normalized.value;
      changedFields.push(field);
    } else if (!partial) {
      value[field] = field === 'hrStatus' ? 'active' : '';
    }
  }

  if (partial && !changedFields.length) return { error: 'No supported HR profile fields supplied' };

  if (!partial || value.employmentType !== undefined) {
    if (value.employmentType && !HR_EMPLOYMENT_TYPES.has(value.employmentType)) return { error: 'Invalid employmentType' };
  }
  if (!partial || value.hrStatus !== undefined) {
    if (!value.hrStatus) value.hrStatus = 'active';
    if (!HR_STATUSES.has(value.hrStatus)) return { error: 'Invalid hrStatus' };
  }
  for (const field of ['startDate', 'contractEndDate']) {
    if (value[field] !== undefined && !isIsoDateText(value[field])) return { error: `${field} must use YYYY-MM-DD format` };
  }

  return { value, changedFields };
}

function publicHrStaffUser(row = {}) {
  return {
    userId: row.userId || row.id || '',
    fullName: row.fullName || '',
    email: row.email || '',
    role: row.role || '',
    isActive: Boolean(row.isActive ?? 1),
  };
}

function publicHrProfile(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    jobTitle: row.jobTitle || '',
    department: row.department || '',
    practiceTeam: row.practiceTeam || '',
    employmentType: row.employmentType || '',
    startDate: row.startDate || '',
    contractEndDate: row.contractEndDate || '',
    supervisorUserId: row.supervisorUserId || '',
    workEmail: row.workEmail || '',
    workPhone: row.workPhone || '',
    emergencyContactName: row.emergencyContactName || '',
    emergencyContactPhone: row.emergencyContactPhone || '',
    hrStatus: row.hrStatus || 'active',
    adminNotes: row.adminNotes || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    createdBy: row.createdBy || '',
    updatedBy: row.updatedBy || '',
  };
}

function publicHrProfileSummary(row = {}) {
  if (!row.profileId) return null;
  return {
    id: row.profileId,
    userId: row.userId,
    jobTitle: row.jobTitle || '',
    department: row.department || '',
    practiceTeam: row.practiceTeam || '',
    employmentType: row.employmentType || '',
    startDate: row.startDate || '',
    contractEndDate: row.contractEndDate || '',
    supervisorUserId: row.supervisorUserId || '',
    workEmail: row.workEmail || '',
    workPhone: row.workPhone || '',
    hrStatus: row.hrStatus || 'active',
    createdAt: row.profileCreatedAt || '',
    updatedAt: row.profileUpdatedAt || '',
  };
}

async function getHrStaffUser(userId) {
  const user = await get('SELECT id,email,fullName,role,isActive FROM users WHERE id=?', [userId]);
  if (!user) return { status: 404, error: 'Staff user not found' };
  if (!HR_STAFF_ROLES.has(user.role)) return { status: 400, error: 'HR profiles are only available for staff users' };
  return { user };
}

async function validateHrSupervisor(supervisorUserId) {
  if (!supervisorUserId) return null;
  const supervisor = await get('SELECT id,role FROM users WHERE id=?', [supervisorUserId]);
  if (!supervisor || !HR_STAFF_ROLES.has(supervisor.role)) return 'supervisorUserId must reference a staff user';
  return null;
}

function hrAuditMetadata(user, changedFields = []) {
  const safeChangedFields = changedFields.filter(field => !HR_AUDIT_SENSITIVE_FIELDS.has(field));
  return {
    userId: user.id || '',
    staffRole: user.role || '',
    changedFieldCount: changedFields.length,
    changedFields: safeChangedFields.join(','),
  };
}

// HR-29E helpers ----------------------------------------------------------

// Strict YYYY-MM-DD validator that rejects impossible calendar dates (e.g. 2026-13-45, 2026-02-30).
function isValidHrDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function publicHrDocument(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    documentType: row.documentType || '',
    title: row.title || '',
    fileName: row.fileName || '',
    mimeType: row.mimeType || '',
    size: row.size || '',
    isActive: Boolean(row.isActive),
    uploadedBy: row.uploadedBy || '',
    uploadedAt: row.uploadedAt || '',
    deletedBy: row.deletedBy || '',
    deletedAt: row.deletedAt || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    staffName: row.staffName || undefined,
    staffEmail: row.staffEmail || undefined,
    staffRole: row.staffRole || undefined,
  };
}

function publicHrContract(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    contractType: row.contractType || '',
    startDate: row.startDate || '',
    endDate: row.endDate || '',
    probationEndDate: row.probationEndDate || '',
    renewalDate: row.renewalDate || '',
    status: row.status || 'active',
    documentId: row.documentId || '',
    notes: row.notes || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    createdBy: row.createdBy || '',
    updatedBy: row.updatedBy || '',
    staff: {
      userId: row.userId,
      fullName: row.staffName || '',
      email: row.staffEmail || '',
      role: row.staffRole || '',
    },
    document: row.documentId && row.docId
      ? {
          id: row.docId,
          documentType: row.docType || '',
          title: row.docTitle || '',
          fileName: row.docFileName || '',
          mimeType: row.docMimeType || '',
          size: row.docSize || '',
          isActive: Boolean(row.docIsActive),
        }
      : null,
  };
}

function hrContractAuditMetadata(contract, user) {
  return {
    contractId: contract.id || '',
    userId: user.id || contract.userId || '',
    contractType: contract.contractType || '',
    status: contract.status || '',
    startDate: contract.startDate || '',
    endDate: contract.endDate || '',
    probationEndDate: contract.probationEndDate || '',
    renewalDate: contract.renewalDate || '',
    documentId: contract.documentId || '',
  };
}

// HR-29F helpers ----------------------------------------------------------

function publicOffboardingChecklistItem(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    offboardingCaseId: row.offboardingCaseId,
    itemKey: row.itemKey || '',
    label: row.label || '',
    status: row.status || 'pending',
    completedBy: row.completedBy || '',
    completedAt: row.completedAt || '',
    notes: row.notes || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
  };
}

// Build the public case shape. `staffRow` carries the joined users columns (or the
// staff user record); `checklist` is an optional array of checklist rows.
function publicOffboardingCase(row = null, checklist = undefined) {
  if (!row) return null;
  const out = {
    id: row.id,
    userId: row.userId,
    status: row.status || 'open',
    exitType: row.exitType || '',
    exitDate: row.exitDate || '',
    reasonCategory: row.reasonCategory || '',
    notes: row.notes || '',
    startedBy: row.startedBy || '',
    startedAt: row.startedAt || '',
    completedBy: row.completedBy || '',
    completedAt: row.completedAt || '',
    cancelledBy: row.cancelledBy || '',
    cancelledAt: row.cancelledAt || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    staff: {
      userId: row.userId,
      fullName: row.staffName || '',
      email: row.staffEmail || '',
      role: row.staffRole || '',
      isActive: Boolean(row.staffIsActive ?? row.staffActive ?? 1),
    },
  };
  if (row.checklistTotal !== undefined) out.checklistTotal = Number(row.checklistTotal) || 0;
  if (row.checklistDone !== undefined) out.checklistDone = Number(row.checklistDone) || 0;
  if (Array.isArray(checklist)) out.checklist = checklist.map(publicOffboardingChecklistItem);
  return out;
}

function offboardingAuditMetadata(extra = {}) {
  // Whitelist of non-sensitive keys allowed in offboarding audit metadata.
  const allowed = ['caseId', 'userId', 'status', 'exitType', 'reasonCategory', 'exitDate', 'itemKey', 'itemStatus', 'activeMatterCount', 'paralegalReferenceCount', 'deactivated'];
  const meta = {};
  for (const key of allowed) {
    if (extra[key] !== undefined) meta[key] = extra[key];
  }
  return meta;
}

const HR_OFFBOARDING_CASE_SELECT = `
  oc.*,
  u.fullName staffName, u.email staffEmail, u.role staffRole, u.isActive staffIsActive,
  (SELECT COUNT(*) FROM hr_offboarding_checklist_items ci WHERE ci.offboardingCaseId = oc.id) checklistTotal,
  (SELECT COUNT(*) FROM hr_offboarding_checklist_items ci WHERE ci.offboardingCaseId = oc.id AND ci.status = 'done') checklistDone`;

async function getOffboardingCaseRow(id) {
  return get(
    `SELECT ${HR_OFFBOARDING_CASE_SELECT} FROM hr_offboarding_cases oc JOIN users u ON u.id = oc.userId WHERE oc.id = ?`,
    [id],
  );
}

async function loadFullOffboardingCase(id) {
  const row = await getOffboardingCaseRow(id);
  if (!row) return null;
  const checklist = await all('SELECT * FROM hr_offboarding_checklist_items WHERE offboardingCaseId = ? ORDER BY createdAt ASC, id ASC', [id]);
  return publicOffboardingCase(row, checklist);
}

// Count active assigned matters for a staff member (by fullName), mirroring the
// app's active-matter definition (excludes Closed and On Hold).
async function countActiveAssignedMatters(fullName) {
  if (!fullName) return 0;
  const placeholders = HR_OFFBOARDING_INACTIVE_STAGES.map(() => '?').join(',');
  const row = await get(
    `SELECT COUNT(*) AS cnt FROM matters WHERE assignedTo = ? AND COALESCE(stage,'') NOT IN (${placeholders})`,
    [fullName, ...HR_OFFBOARDING_INACTIVE_STAGES],
  );
  return row ? Number(row.cnt) || 0 : 0;
}

function normalizeLeaveType(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ALLOWED_LEAVE_TYPES.has(text) ? text : null;
}

function normalizeIsoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(trimmed + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return null;
  return trimmed;
}

function calculateLeaveDays(startDate, endDate) {
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate + 'T00:00:00');
  const diff = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  return diff > 0 ? diff : 0;
}

function normalizeLeaveReason(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > 2000) return null;
  return text;
}

function normalizeDecisionNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > 2000) return null;
  return text;
}

function publicLeaveRequest(row = {}) {
  return {
    id: row.id || '',
    userId: row.userId || '',
    leaveType: row.leaveType || '',
    startDate: row.startDate || '',
    endDate: row.endDate || '',
    days: Number(row.days) || 0,
    reason: row.reason || '',
    status: row.status || 'pending',
    requestedAt: row.requestedAt || '',
    decidedBy: row.decidedBy || '',
    decidedAt: row.decidedAt || '',
    decisionNote: row.decisionNote || '',
    cancelledBy: row.cancelledBy || '',
    cancelledAt: row.cancelledAt || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    fullName: row.fullName || '',
    email: row.email || '',
    role: row.role || '',
  };
}

function publicLeaveRequestSummary(row = {}) {
  return {
    id: row.id || '',
    userId: row.userId || '',
    leaveType: row.leaveType || '',
    startDate: row.startDate || '',
    endDate: row.endDate || '',
    days: Number(row.days) || 0,
    status: row.status || 'pending',
    requestedAt: row.requestedAt || '',
    decidedBy: row.decidedBy || '',
    decidedAt: row.decidedAt || '',
    cancelledBy: row.cancelledBy || '',
    cancelledAt: row.cancelledAt || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    fullName: row.fullName || '',
    email: row.email || '',
    role: row.role || '',
  };
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

// LOCAL-PILOT-FIX-9: heal client portal users created while the staff "Linked
// Client" dropdown submitted the client NAME instead of the client id. Only
// rewrites client-role users whose clientId matches no client record but does
// exactly match one client's name; unknown or ambiguous values are left alone.
async function repairClientUserLinks() {
  await run(`UPDATE users SET clientId=(SELECT id FROM clients WHERE name=users.clientId)
    WHERE role='client'
      AND clientId IS NOT NULL AND clientId<>''
      AND NOT EXISTS (SELECT 1 FROM clients WHERE id=users.clientId)
      AND (SELECT COUNT(*) FROM clients WHERE name=users.clientId)=1`);
}

function publicRetainerRecord(row) {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName || '',
    matterId: row.matterId || '',
    matterTitle: row.matterTitle || '',
    matterReference: row.matterReference || '',
    status: row.status || 'not_started',
    engagementType: row.engagementType || '',
    engagementStartDate: row.engagementStartDate || '',
    signedDate: row.signedDate || '',
    responsibleAdvocate: row.responsibleAdvocate || '',
    scopeSummary: row.scopeSummary || '',
    exclusionsSummary: row.exclusionsSummary || '',
    clientObligationsSummary: row.clientObligationsSummary || '',
    firmObligationsSummary: row.firmObligationsSummary || '',
    billingArrangementSummary: row.billingArrangementSummary || '',
    terminationTermsSummary: row.terminationTermsSummary || '',
    isActive: Number(row.isActive || 1) === 1,
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    deactivatedAt: row.deactivatedAt || '',
  };
}

// RET-31E: normalize a numeric fee-plan field to a number or null (no computation).
function feePlanNumOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

// RET-31E: validate a numeric field is blank/null or a finite number >= 0.
function feePlanNumericError(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return `${label} must be a number`;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${label} must be a valid number`;
  if (n < 0) return `${label} must be greater than or equal to 0`;
  return null;
}

// RET-31E: shared payload validation for matter fee plans.
// partial=true skips the required-field checks (used by PATCH).
function validateFeePlanPayload(payload, { partial = false } = {}) {
  const p = payload || {};
  if (!partial) {
    if (!p.clientId) return 'clientId is required';
    if (!p.matterId) return 'matterId is required';
    if (!p.feeType) return 'feeType is required';
  }
  if (p.feeType !== undefined && !ALLOWED_FEE_PLAN_TYPES.has(p.feeType)) return `Invalid feeType. Allowed: ${[...ALLOWED_FEE_PLAN_TYPES].join(', ')}`;
  if (p.status !== undefined && p.status !== '' && p.status !== null && !ALLOWED_FEE_PLAN_STATUSES.has(p.status)) return `Invalid status. Allowed: ${[...ALLOWED_FEE_PLAN_STATUSES].join(', ')}`;
  if (p.billingFrequency !== undefined && p.billingFrequency !== '' && p.billingFrequency !== null && !ALLOWED_FEE_PLAN_BILLING_FREQUENCIES.has(p.billingFrequency)) return `Invalid billingFrequency. Allowed: ${[...ALLOWED_FEE_PLAN_BILLING_FREQUENCIES].join(', ')}`;
  if (p.vatTreatment !== undefined && p.vatTreatment !== '' && p.vatTreatment !== null && !ALLOWED_FEE_PLAN_VAT_TREATMENTS.has(p.vatTreatment)) return `Invalid vatTreatment. Allowed: ${[...ALLOWED_FEE_PLAN_VAT_TREATMENTS].join(', ')}`;
  if (p.disbursementsTreatment !== undefined && p.disbursementsTreatment !== '' && p.disbursementsTreatment !== null && !ALLOWED_FEE_PLAN_DISBURSEMENTS_TREATMENTS.has(p.disbursementsTreatment)) return `Invalid disbursementsTreatment. Allowed: ${[...ALLOWED_FEE_PLAN_DISBURSEMENTS_TREATMENTS].join(', ')}`;
  for (const f of ['estimatedAmount', 'hourlyRate', 'capAmount', 'depositRequired']) {
    const err = feePlanNumericError(p[f], f);
    if (err) return err;
  }
  if (p.currency !== undefined && p.currency !== null && String(p.currency).length > 10) return 'currency exceeds 10 characters';
  if ((p.paymentTerms || '').length > 5000) return 'paymentTerms exceeds 5000 characters';
  if ((p.notes || '').length > 10000) return 'notes exceeds 10000 characters';
  return null;
}

function publicFeePlan(row) {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName || '',
    matterId: row.matterId || '',
    matterTitle: row.matterTitle || '',
    matterReference: row.matterReference || '',
    retainerId: row.retainerId || '',
    feeType: row.feeType || '',
    currency: row.currency || 'KES',
    estimatedAmount: feePlanNumOrNull(row.estimatedAmount),
    hourlyRate: feePlanNumOrNull(row.hourlyRate),
    capAmount: feePlanNumOrNull(row.capAmount),
    depositRequired: feePlanNumOrNull(row.depositRequired),
    billingFrequency: row.billingFrequency || '',
    paymentTerms: row.paymentTerms || '',
    vatTreatment: row.vatTreatment || '',
    disbursementsTreatment: row.disbursementsTreatment || '',
    status: row.status || 'draft',
    notes: row.notes || '',
    isActive: Number(row.isActive || 1) === 1,
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    deactivatedAt: row.deactivatedAt || '',
  };
}

// RET-31F: validate a retainer ledger payload (append-only money record).
// Returns an error string, or null when valid.
function validateLedgerPayload(payload) {
  const p = payload || {};
  if (!p.clientId) return 'clientId is required';
  if (!p.entryType) return 'entryType is required';
  if (!p.direction) return 'direction is required';
  if (!ALLOWED_LEDGER_ENTRY_TYPES.has(p.entryType)) return `Invalid entryType. Allowed: ${[...ALLOWED_LEDGER_ENTRY_TYPES].join(', ')}`;
  if (!ALLOWED_LEDGER_DIRECTIONS.has(p.direction)) return `Invalid direction. Allowed: ${[...ALLOWED_LEDGER_DIRECTIONS].join(', ')}`;
  const requiredDirection = LEDGER_REQUIRED_DIRECTION[p.entryType];
  if (requiredDirection && p.direction !== requiredDirection) return `${p.entryType} must be a ${requiredDirection}`;
  if (p.amount === undefined || p.amount === null || p.amount === '') return 'amount is required';
  if (typeof p.amount === 'boolean') return 'amount must be a number';
  const amt = Number(p.amount);
  if (!Number.isFinite(amt)) return 'amount must be a valid number';
  if (amt <= 0) return 'amount must be greater than 0';
  if (!p.entryDate) return 'entryDate is required';
  if (Number.isNaN(new Date(p.entryDate).getTime())) return 'Invalid entryDate';
  if (p.currency !== undefined && p.currency !== null && String(p.currency).length > 10) return 'currency exceeds 10 characters';
  if ((p.reference || '').length > 200) return 'reference exceeds 200 characters';
  if ((p.description || '').length > 2000) return 'description exceeds 2000 characters';
  if ((p.sourceType || '').length > 80) return 'sourceType exceeds 80 characters';
  if ((p.sourceId || '').length > 120) return 'sourceId exceeds 120 characters';
  return null;
}

function publicLedgerEntry(row) {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName || '',
    matterId: row.matterId || '',
    matterTitle: row.matterTitle || '',
    matterReference: row.matterReference || '',
    retainerId: row.retainerId || '',
    feePlanId: row.feePlanId || '',
    entryType: row.entryType || '',
    direction: row.direction || '',
    amount: Number(row.amount || 0),
    currency: row.currency || 'KES',
    entryDate: row.entryDate || '',
    reference: row.reference || '',
    description: row.description || '',
    sourceType: row.sourceType || '',
    sourceId: row.sourceId || '',
    isVoided: Number(row.isVoided || 0) === 1,
    voidedBy: row.voidedBy || '',
    voidedAt: row.voidedAt || '',
    voidReason: row.voidReason || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
  };
}

// RET-31F: compute a display-only summary from ledger rows. Considers non-voided rows
// only. Groups by currency so mixed currencies are never summed into one misleading total.
function computeLedgerSummary(rows) {
  const active = (rows || []).filter(r => Number(r.isVoided || 0) !== 1);
  const groups = new Map();
  for (const r of active) {
    const cur = r.currency || 'KES';
    if (!groups.has(cur)) groups.set(cur, { currency: cur, totalCredits: 0, totalDebits: 0, balance: 0, entryCount: 0 });
    const g = groups.get(cur);
    const amt = Number(r.amount || 0);
    if (r.direction === 'credit') g.totalCredits += amt;
    else if (r.direction === 'debit') g.totalDebits += amt;
    g.balance = g.totalCredits - g.totalDebits;
    g.entryCount += 1;
  }
  const byCurrency = [...groups.values()];
  if (byCurrency.length <= 1) {
    const only = byCurrency[0] || { currency: 'KES', totalCredits: 0, totalDebits: 0, balance: 0, entryCount: 0 };
    return { currency: only.currency, totalCredits: only.totalCredits, totalDebits: only.totalDebits, balance: only.balance, entryCount: only.entryCount };
  }
  // Mixed currencies: do NOT sum across currencies; expose the grouped breakdown.
  return {
    currency: 'MIXED',
    totalCredits: null,
    totalDebits: null,
    balance: null,
    entryCount: active.length,
    byCurrency,
  };
}

// RET-31F: whitelist audit metadata (excludes description/reference/voidReason/source*).
function ledgerAuditMetadata(row, isVoidedOverride) {
  return {
    ledgerEntryId: row.id,
    clientId: row.clientId,
    matterId: row.matterId || '',
    retainerId: row.retainerId || '',
    feePlanId: row.feePlanId || '',
    entryType: row.entryType || '',
    direction: row.direction || '',
    amount: Number(row.amount || 0),
    currency: row.currency || '',
    entryDate: row.entryDate || '',
    isVoided: isVoidedOverride !== undefined ? isVoidedOverride : Number(row.isVoided || 0),
    voidedBy: row.voidedBy || '',
  };
}

// RET-31G: validate a client KYC/CDD payload (metadata only). Returns error string or null.
function validateKycPayload(payload, { partial = false } = {}) {
  const p = payload || {};
  if (!partial) {
    if (!p.clientId) return 'clientId is required';
  }
  if (p.status !== undefined && p.status !== '' && p.status !== null && !ALLOWED_KYC_STATUSES.has(p.status)) return `Invalid status. Allowed: ${[...ALLOWED_KYC_STATUSES].join(', ')}`;
  if (p.clientCategory !== undefined && p.clientCategory !== '' && p.clientCategory !== null && !ALLOWED_KYC_CLIENT_CATEGORIES.has(p.clientCategory)) return `Invalid clientCategory. Allowed: ${[...ALLOWED_KYC_CLIENT_CATEGORIES].join(', ')}`;
  if (p.riskLevel !== undefined && p.riskLevel !== '' && p.riskLevel !== null && !ALLOWED_KYC_RISK_LEVELS.has(p.riskLevel)) return `Invalid riskLevel. Allowed: ${[...ALLOWED_KYC_RISK_LEVELS].join(', ')}`;
  if (p.pepStatus !== undefined && p.pepStatus !== '' && p.pepStatus !== null && !ALLOWED_KYC_PEP_STATUSES.has(p.pepStatus)) return `Invalid pepStatus. Allowed: ${[...ALLOWED_KYC_PEP_STATUSES].join(', ')}`;
  if (p.sanctionsCheckStatus !== undefined && p.sanctionsCheckStatus !== '' && p.sanctionsCheckStatus !== null && !ALLOWED_KYC_SANCTIONS_STATUSES.has(p.sanctionsCheckStatus)) return `Invalid sanctionsCheckStatus. Allowed: ${[...ALLOWED_KYC_SANCTIONS_STATUSES].join(', ')}`;
  if (p.verificationDate !== undefined && p.verificationDate !== '' && p.verificationDate !== null && Number.isNaN(new Date(p.verificationDate).getTime())) return 'Invalid verificationDate';
  if (p.expiryDate !== undefined && p.expiryDate !== '' && p.expiryDate !== null && Number.isNaN(new Date(p.expiryDate).getTime())) return 'Invalid expiryDate';
  if ((p.idNumber || '').length > 100) return 'idNumber exceeds 100 characters';
  if ((p.kraPin || '').length > 100) return 'kraPin exceeds 100 characters';
  if ((p.registrationNumber || '').length > 100) return 'registrationNumber exceeds 100 characters';
  if ((p.sourceOfFundsSummary || '').length > 5000) return 'sourceOfFundsSummary exceeds 5000 characters';
  if ((p.notes || '').length > 10000) return 'notes exceeds 10000 characters';
  if ((p.verifiedBy || '').length > 160) return 'verifiedBy exceeds 160 characters';
  return null;
}

function publicKycRecord(row) {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName || '',
    status: row.status || 'not_started',
    clientCategory: row.clientCategory || '',
    riskLevel: row.riskLevel || '',
    idNumber: row.idNumber || '',
    kraPin: row.kraPin || '',
    registrationNumber: row.registrationNumber || '',
    verificationDate: row.verificationDate || '',
    expiryDate: row.expiryDate || '',
    sourceOfFundsSummary: row.sourceOfFundsSummary || '',
    pepStatus: row.pepStatus || '',
    sanctionsCheckStatus: row.sanctionsCheckStatus || '',
    verifiedBy: row.verifiedBy || '',
    notes: row.notes || '',
    isActive: Number(row.isActive || 1) === 1,
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    deactivatedAt: row.deactivatedAt || '',
  };
}

// RET-31G: whitelist audit metadata (excludes all sensitive PII / free text).
function kycAuditMetadata(row, isActiveOverride) {
  return {
    kycRecordId: row.id,
    clientId: row.clientId,
    status: row.status || '',
    clientCategory: row.clientCategory || '',
    riskLevel: row.riskLevel || '',
    expiryDate: row.expiryDate || '',
    isActive: isActiveOverride !== undefined ? isActiveOverride : Number(row.isActive || 0),
  };
}

// RET-31H: client authority record helpers (metadata only).
const AUTHORITY_SELECT = `SELECT r.*, c.name clientName
  FROM client_authority_records r LEFT JOIN clients c ON c.id=r.clientId`;

function publicAuthorityRecord(row) {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName || '',
    status: row.status || 'pending',
    authorityBasis: row.authorityBasis || '',
    authorisedPersonName: row.authorisedPersonName || '',
    authorisedPersonRole: row.authorisedPersonRole || '',
    authorisedPersonEmail: row.authorisedPersonEmail || '',
    authorisedPersonPhone: row.authorisedPersonPhone || '',
    authorityDate: row.authorityDate || '',
    expiryDate: row.expiryDate || '',
    notes: row.notes || '',
    isActive: Number(row.isActive) === 1,
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    deactivatedAt: row.deactivatedAt || '',
  };
}

async function canAccessAuthority(req, clientId) {
  if (req.user.role === 'admin' || req.user.role === 'assistant') return true;
  if (req.user.role === 'advocate') return canAccessClient(req, clientId);
  return false;
}

function validateAuthorityPayload(payload, { partial = false } = {}) {
  const p = payload || {};
  if (!partial) {
    if (!p.clientId) return 'clientId is required';
  }
  if (p.status !== undefined && p.status !== '' && p.status !== null && !ALLOWED_AUTHORITY_STATUSES.has(p.status)) return `Invalid status. Allowed: ${[...ALLOWED_AUTHORITY_STATUSES].join(', ')}`;
  if (p.authorityBasis !== undefined && p.authorityBasis !== '' && p.authorityBasis !== null && !ALLOWED_AUTHORITY_BASIS.has(p.authorityBasis)) return `Invalid authorityBasis. Allowed: ${[...ALLOWED_AUTHORITY_BASIS].join(', ')}`;
  if (p.authorityDate !== undefined && p.authorityDate !== '' && p.authorityDate !== null && Number.isNaN(new Date(p.authorityDate).getTime())) return 'Invalid authorityDate';
  if (p.expiryDate !== undefined && p.expiryDate !== '' && p.expiryDate !== null && Number.isNaN(new Date(p.expiryDate).getTime())) return 'Invalid expiryDate';
  if ((p.authorisedPersonName || '').length > 160) return 'authorisedPersonName exceeds 160 characters';
  if ((p.authorisedPersonRole || '').length > 120) return 'authorisedPersonRole exceeds 120 characters';
  if ((p.authorisedPersonEmail || '').length > 160) return 'authorisedPersonEmail exceeds 160 characters';
  if ((p.authorisedPersonPhone || '').length > 80) return 'authorisedPersonPhone exceeds 80 characters';
  if ((p.notes || '').length > 10000) return 'notes exceeds 10000 characters';
  return null;
}

function authorityAuditMetadata(rowOrPayload) {
  return {
    authorityRecordId: rowOrPayload.id,
    clientId: rowOrPayload.clientId,
    status: rowOrPayload.status || '',
    authorityBasis: rowOrPayload.authorityBasis || '',
    expiryDate: rowOrPayload.expiryDate || '',
    isActive: Number(rowOrPayload.isActive ?? 1),
  };
}

// RET-31I: retainer lifecycle event helpers (append-only record; no side-effect mutations).
const LIFECYCLE_EVENT_SELECT = `SELECT r.*, c.name clientName
  FROM retainer_lifecycle_events r LEFT JOIN clients c ON c.id=r.clientId`;

function publicLifecycleEvent(row) {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName || '',
    matterId: row.matterId || '',
    retainerId: row.retainerId || '',
    eventType: row.eventType || '',
    status: row.status || 'recorded',
    effectiveDate: row.effectiveDate || '',
    noticeDate: row.noticeDate || '',
    title: row.title || '',
    summary: row.summary || '',
    reason: row.reason || '',
    scopeBeforeSummary: row.scopeBeforeSummary || '',
    scopeAfterSummary: row.scopeAfterSummary || '',
    clientObligationsSummary: row.clientObligationsSummary || '',
    firmObligationsSummary: row.firmObligationsSummary || '',
    isActive: Number(row.isActive) === 1,
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    deactivatedAt: row.deactivatedAt || '',
  };
}

function lifecycleEventAuditMetadata(row) {
  return {
    lifecycleEventId: row.id,
    clientId: row.clientId,
    matterId: row.matterId || '',
    retainerId: row.retainerId || '',
    eventType: row.eventType || '',
    status: row.status || '',
    effectiveDate: row.effectiveDate || '',
    noticeDate: row.noticeDate || '',
    title: row.title || '',
    isActive: Number(row.isActive ?? 1),
  };
}

async function canAccessLifecycleEvent(req, clientId, matterId) {
  if (req.user.role === 'admin' || req.user.role === 'assistant') return true;
  if (req.user.role === 'advocate') {
    if (!(await canAccessClient(req, clientId))) return false;
    if (matterId && !(await canAccessMatter(req, matterId))) return false;
    return true;
  }
  return false;
}

function validateLifecycleEventPayload(payload, { partial = false } = {}) {
  const p = payload || {};
  if (!partial) {
    if (!p.clientId) return 'clientId is required';
    if (!p.eventType) return 'eventType is required';
  }
  if (p.eventType !== undefined && !ALLOWED_LIFECYCLE_EVENT_TYPES.has(p.eventType)) {
    return `Invalid eventType. Allowed: ${[...ALLOWED_LIFECYCLE_EVENT_TYPES].join(', ')}`;
  }
  if (p.status !== undefined && !ALLOWED_LIFECYCLE_STATUSES.has(p.status)) {
    return `Invalid status. Allowed: ${[...ALLOWED_LIFECYCLE_STATUSES].join(', ')}`;
  }
  if (p.effectiveDate !== undefined && p.effectiveDate !== '' && p.effectiveDate !== null && Number.isNaN(new Date(p.effectiveDate).getTime())) {
    return 'Invalid effectiveDate';
  }
  if (p.noticeDate !== undefined && p.noticeDate !== '' && p.noticeDate !== null && Number.isNaN(new Date(p.noticeDate).getTime())) {
    return 'Invalid noticeDate';
  }
  if ((p.title || '').length > 200) return 'title exceeds 200 characters';
  if ((p.summary || '').length > 5000) return 'summary exceeds 5000 characters';
  if ((p.reason || '').length > 5000) return 'reason exceeds 5000 characters';
  if ((p.scopeBeforeSummary || '').length > 5000) return 'scopeBeforeSummary exceeds 5000 characters';
  if ((p.scopeAfterSummary || '').length > 5000) return 'scopeAfterSummary exceeds 5000 characters';
  if ((p.clientObligationsSummary || '').length > 5000) return 'clientObligationsSummary exceeds 5000 characters';
  if ((p.firmObligationsSummary || '').length > 5000) return 'firmObligationsSummary exceeds 5000 characters';
  return null;
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
  const moduleSettings = settings ? resolveModuleSettings(settings.moduleSettingsJson) : { ...DEFAULT_MODULE_SETTINGS };
  const { moduleSettingsJson: _msj, ...safeSettings } = settings || {};
  const normalized = { ...defaultFirmSettings, ...safeSettings };
  normalized.defaultInvoiceDueDays = normalizeDefaultInvoiceDueDays(normalized.defaultInvoiceDueDays);
  return { ...normalized, reminderSettings, theme: theme || null, moduleSettings };
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin','client')) DEFAULT 'assistant', clientId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'Individual', contact TEXT, email TEXT, phone TEXT, status TEXT DEFAULT 'Active', joinDate TEXT, conflictCleared INTEGER DEFAULT 0, retainer REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, reference TEXT UNIQUE, clientId TEXT NOT NULL, title TEXT NOT NULL, practiceArea TEXT, stage TEXT DEFAULT 'Intake', assignedTo TEXT, paralegal TEXT, openDate TEXT, description TEXT, court TEXT, judge TEXT, caseNo TEXT, opposingCounsel TEXT, billingRate REAL DEFAULT 0, retainerBalance REAL DEFAULT 0, totalBilled REAL DEFAULT 0, priority TEXT DEFAULT 'Medium', solDate TEXT, billingType TEXT DEFAULT 'hourly', fixedFee REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, assignee TEXT, dueDate TEXT, auto_generated INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS time_entries (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, attorney TEXT, date TEXT, hours REAL DEFAULT 0, activity TEXT, description TEXT, rate REAL DEFAULT 0, billed INTEGER DEFAULT 0, billable INTEGER DEFAULT 1)`);
  await run(`CREATE TABLE IF NOT EXISTS appearances (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT, date TEXT, time TEXT, type TEXT, location TEXT, meetingLink TEXT, attorney TEXT, prepNote TEXT, outcome TEXT DEFAULT '', attendanceStatus TEXT DEFAULT 'scheduled', appearedBy TEXT DEFAULT '', clientAttended INTEGER NOT NULL DEFAULT 0, attendanceNote TEXT DEFAULT '', attendanceUpdatedBy TEXT, attendanceUpdatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS appearance_prep_items (id TEXT PRIMARY KEY, appearanceId TEXT NOT NULL, matterId TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', status TEXT NOT NULL DEFAULT 'open', notes TEXT DEFAULT '', createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, completedBy TEXT, completedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS appearance_documents (id TEXT PRIMARY KEY, appearanceId TEXT NOT NULL, documentId TEXT NOT NULL, matterId TEXT NOT NULL, label TEXT DEFAULT '', notes TEXT DEFAULT '', createdBy TEXT NOT NULL, createdAt TEXT NOT NULL)`);
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
  await run(`CREATE TABLE IF NOT EXISTS retainer_records (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, matterId TEXT, status TEXT NOT NULL DEFAULT 'not_started', engagementType TEXT, engagementStartDate TEXT, signedDate TEXT, responsibleAdvocate TEXT, scopeSummary TEXT DEFAULT '', exclusionsSummary TEXT DEFAULT '', clientObligationsSummary TEXT DEFAULT '', firmObligationsSummary TEXT DEFAULT '', billingArrangementSummary TEXT DEFAULT '', terminationTermsSummary TEXT DEFAULT '', notes TEXT DEFAULT '', isActive INTEGER NOT NULL DEFAULT 1, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, deactivatedBy TEXT, deactivatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS matter_fee_plans (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, matterId TEXT NOT NULL, retainerId TEXT, feeType TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'KES', estimatedAmount REAL, hourlyRate REAL, capAmount REAL, depositRequired REAL, billingFrequency TEXT, paymentTerms TEXT, vatTreatment TEXT, disbursementsTreatment TEXT, status TEXT NOT NULL DEFAULT 'draft', notes TEXT DEFAULT '', isActive INTEGER NOT NULL DEFAULT 1, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, deactivatedBy TEXT, deactivatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS retainer_ledger_entries (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, matterId TEXT, retainerId TEXT, feePlanId TEXT, entryType TEXT NOT NULL, direction TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'KES', entryDate TEXT NOT NULL, reference TEXT, description TEXT, sourceType TEXT, sourceId TEXT, isVoided INTEGER NOT NULL DEFAULT 0, voidedBy TEXT, voidedAt TEXT, voidReason TEXT, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS client_kyc_records (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'not_started', clientCategory TEXT, riskLevel TEXT, idNumber TEXT, kraPin TEXT, registrationNumber TEXT, verificationDate TEXT, expiryDate TEXT, sourceOfFundsSummary TEXT DEFAULT '', pepStatus TEXT, sanctionsCheckStatus TEXT, verifiedBy TEXT, notes TEXT DEFAULT '', isActive INTEGER NOT NULL DEFAULT 1, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, deactivatedBy TEXT, deactivatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS client_authority_records (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', authorityBasis TEXT, authorisedPersonName TEXT, authorisedPersonRole TEXT, authorisedPersonEmail TEXT, authorisedPersonPhone TEXT, authorityDate TEXT, expiryDate TEXT, notes TEXT DEFAULT '', isActive INTEGER NOT NULL DEFAULT 1, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, deactivatedBy TEXT, deactivatedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS retainer_lifecycle_events (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, matterId TEXT, retainerId TEXT, eventType TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'recorded', effectiveDate TEXT, noticeDate TEXT, title TEXT, summary TEXT DEFAULT '', reason TEXT DEFAULT '', scopeBeforeSummary TEXT DEFAULT '', scopeAfterSummary TEXT DEFAULT '', clientObligationsSummary TEXT DEFAULT '', firmObligationsSummary TEXT DEFAULT '', isActive INTEGER NOT NULL DEFAULT 1, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, deactivatedBy TEXT, deactivatedAt TEXT)`);
  // KENYA-32B: legal deadline rule library (advocate-verified planning data; no hard-coded periods, no auto deadline creation).
  await run(`CREATE TABLE IF NOT EXISTS legal_deadline_rules (id TEXT PRIMARY KEY, ruleType TEXT NOT NULL, jurisdiction TEXT NOT NULL DEFAULT 'Kenya', legalArea TEXT, causeOfAction TEXT, title TEXT NOT NULL, triggerEvent TEXT NOT NULL, periodValue INTEGER NOT NULL, periodUnit TEXT NOT NULL, computationMode TEXT DEFAULT 'calendar', citation TEXT NOT NULL, notes TEXT DEFAULT '', effectiveFrom TEXT, effectiveTo TEXT, version INTEGER NOT NULL DEFAULT 1, isActive INTEGER NOT NULL DEFAULT 1, verifiedBy TEXT, verifiedAt TEXT, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, deactivatedBy TEXT, deactivatedAt TEXT)`);
  // KENYA-32D: advocate/admin rule review controls (idempotent — added to the table above).
  await ensureColumn('legal_deadline_rules', 'reviewStatus', "TEXT NOT NULL DEFAULT 'pending'");
  await ensureColumn('legal_deadline_rules', 'reviewedBy', 'TEXT');
  await ensureColumn('legal_deadline_rules', 'reviewedAt', 'TEXT');
  await ensureColumn('legal_deadline_rules', 'nextReviewDate', 'TEXT');
  await ensureColumn('legal_deadline_rules', 'reviewComment', "TEXT DEFAULT ''");
  // KENYA-32C: persisted legal deadline suggestions (advocate planning aids; snapshot of a rule + trigger date). Confirmation creates exactly one real deadline; suggestions never auto-create.
  await run(`CREATE TABLE IF NOT EXISTS legal_deadline_suggestions (id TEXT PRIMARY KEY, ruleId TEXT NOT NULL, matterId TEXT, clientId TEXT, triggerDate TEXT NOT NULL, suggestedDueDate TEXT NOT NULL, title TEXT NOT NULL, ruleType TEXT NOT NULL, jurisdiction TEXT NOT NULL, legalArea TEXT, causeOfAction TEXT, triggerEvent TEXT NOT NULL, periodValue INTEGER NOT NULL, periodUnit TEXT NOT NULL, computationMode TEXT NOT NULL DEFAULT 'calendar', citation TEXT NOT NULL, disclaimer TEXT NOT NULL, requiresAdvocateVerification INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', confirmedDeadlineId TEXT, notes TEXT DEFAULT '', createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT, confirmedBy TEXT, confirmedAt TEXT, cancelledBy TEXT, cancelledAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS signature_assets (id TEXT PRIMARY KEY, ownerType TEXT NOT NULL CHECK(ownerType IN ('user','firm')), ownerId TEXT, assetType TEXT NOT NULL CHECK(assetType IN ('signature','stamp')), label TEXT NOT NULL, mimeType TEXT NOT NULL, content BLOB NOT NULL, size INTEGER, isDefault INTEGER DEFAULT 0, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT, deletedAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS hr_staff_profiles (id TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE, jobTitle TEXT, department TEXT, practiceTeam TEXT, employmentType TEXT, startDate TEXT, contractEndDate TEXT, supervisorUserId TEXT, workEmail TEXT, workPhone TEXT, emergencyContactName TEXT, emergencyContactPhone TEXT, hrStatus TEXT NOT NULL DEFAULT 'active', adminNotes TEXT, createdAt TEXT NOT NULL, updatedAt TEXT, createdBy TEXT, updatedBy TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS hr_leave_requests (
id TEXT PRIMARY KEY,
userId TEXT NOT NULL,
leaveType TEXT NOT NULL CHECK(leaveType IN ('annual','sick','compassionate','maternity','paternity','study_exam','unpaid','other')),
startDate TEXT NOT NULL,
endDate TEXT NOT NULL,
days REAL NOT NULL,
reason TEXT DEFAULT '',
status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
requestedAt TEXT NOT NULL,
decidedBy TEXT,
decidedAt TEXT,
decisionNote TEXT DEFAULT '',
cancelledBy TEXT,
cancelledAt TEXT,
createdAt TEXT NOT NULL,
updatedAt TEXT
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_userId ON hr_leave_requests(userId)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_status ON hr_leave_requests(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_userId_status ON hr_leave_requests(userId, status)');

  await run(`CREATE TABLE IF NOT EXISTS hr_leave_entitlements (
id TEXT PRIMARY KEY,
userId TEXT NOT NULL,
leaveType TEXT NOT NULL CHECK(leaveType IN ('annual','sick','compassionate','maternity','paternity','study_exam','unpaid','other')),
year INTEGER NOT NULL,
entitlementDays REAL NOT NULL DEFAULT 0,
createdAt TEXT NOT NULL,
updatedAt TEXT,
createdBy TEXT,
updatedBy TEXT,
UNIQUE(userId, leaveType, year)
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_hr_leave_entitlements_user_year ON hr_leave_entitlements(userId, year)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_leave_entitlements_year_type ON hr_leave_entitlements(year, leaveType)');

  await run(`CREATE TABLE IF NOT EXISTS hr_leave_balance_adjustments (
id TEXT PRIMARY KEY,
userId TEXT NOT NULL,
leaveType TEXT NOT NULL CHECK(leaveType IN ('annual','sick','compassionate','maternity','paternity','study_exam','unpaid','other')),
year INTEGER NOT NULL,
days REAL NOT NULL,
reason TEXT DEFAULT '',
createdAt TEXT NOT NULL,
createdBy TEXT
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_hr_leave_balance_adjustments_user_year ON hr_leave_balance_adjustments(userId, year)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_leave_balance_adjustments_year_type ON hr_leave_balance_adjustments(year, leaveType)');

  // HR-29E: HR document records (separate storage from matter documents) and contract records
  await run(`CREATE TABLE IF NOT EXISTS hr_documents (
id TEXT PRIMARY KEY,
userId TEXT NOT NULL,
documentType TEXT NOT NULL,
title TEXT NOT NULL,
fileName TEXT NOT NULL,
mimeType TEXT NOT NULL,
size TEXT,
content BLOB NOT NULL,
isActive INTEGER NOT NULL DEFAULT 1,
uploadedBy TEXT NOT NULL,
uploadedAt TEXT NOT NULL,
deletedBy TEXT,
deletedAt TEXT,
createdAt TEXT NOT NULL,
updatedAt TEXT
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_hr_documents_userId ON hr_documents(userId)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_documents_userId_active ON hr_documents(userId, isActive)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_documents_type ON hr_documents(documentType)');

  await run(`CREATE TABLE IF NOT EXISTS hr_contract_records (
id TEXT PRIMARY KEY,
userId TEXT NOT NULL,
contractType TEXT NOT NULL,
startDate TEXT,
endDate TEXT,
probationEndDate TEXT,
renewalDate TEXT,
status TEXT NOT NULL DEFAULT 'active',
documentId TEXT,
notes TEXT,
createdAt TEXT NOT NULL,
updatedAt TEXT,
createdBy TEXT NOT NULL,
updatedBy TEXT
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_hr_contract_records_userId ON hr_contract_records(userId)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_contract_records_status ON hr_contract_records(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_contract_records_endDate ON hr_contract_records(endDate)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_contract_records_documentId ON hr_contract_records(documentId)');

  // HR-29F: staff offboarding cases + checklist items
  await run(`CREATE TABLE IF NOT EXISTS hr_offboarding_cases (
id TEXT PRIMARY KEY,
userId TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'open',
exitType TEXT,
exitDate TEXT,
reasonCategory TEXT,
notes TEXT,
startedBy TEXT NOT NULL,
startedAt TEXT NOT NULL,
completedBy TEXT,
completedAt TEXT,
cancelledBy TEXT,
cancelledAt TEXT,
createdAt TEXT NOT NULL,
updatedAt TEXT
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_hr_offboarding_cases_userId ON hr_offboarding_cases(userId)');
  await run('CREATE INDEX IF NOT EXISTS idx_hr_offboarding_cases_status ON hr_offboarding_cases(status)');

  await run(`CREATE TABLE IF NOT EXISTS hr_offboarding_checklist_items (
id TEXT PRIMARY KEY,
offboardingCaseId TEXT NOT NULL,
itemKey TEXT NOT NULL,
label TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'pending',
completedBy TEXT,
completedAt TEXT,
notes TEXT,
createdAt TEXT NOT NULL,
updatedAt TEXT
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_hr_offboarding_checklist_caseId ON hr_offboarding_checklist_items(offboardingCaseId)');

  // TIMELINE-30D: matter stage history (captures future stage changes; matters.stage stays source of truth)
  await run(`CREATE TABLE IF NOT EXISTS matter_stage_history (
id TEXT PRIMARY KEY,
matterId TEXT NOT NULL,
oldStage TEXT,
newStage TEXT NOT NULL,
changedBy TEXT,
changedByName TEXT,
changedAt TEXT NOT NULL,
source TEXT NOT NULL DEFAULT 'manual',
note TEXT DEFAULT '',
createdAt TEXT NOT NULL
)`);
  await run('CREATE INDEX IF NOT EXISTS idx_matter_stage_history_matterId ON matter_stage_history(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_matter_stage_history_changedAt ON matter_stage_history(changedAt)');

  await ensureClientUserSupport();
  await repairClientUserLinks();
  await ensureColumn('matter_checklist_items', 'dueDate', 'TEXT');
  await ensureColumn('matter_checklist_items', 'assignee', 'TEXT');
  await ensureColumn('matter_checklist_items', 'updatedAt', 'TEXT');
  await ensureColumn('users', 'tokenVersion', 'INTEGER DEFAULT 1');
  await ensureColumn('appearances', 'meetingLink', 'TEXT');
  await ensureColumn('appearances', 'outcome', "TEXT DEFAULT ''");
  await ensureColumn('appearances', 'attendanceStatus', "TEXT DEFAULT 'scheduled'");
  await ensureColumn('appearances', 'appearedBy', "TEXT DEFAULT ''");
  await ensureColumn('appearances', 'clientAttended', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('appearances', 'attendanceNote', "TEXT DEFAULT ''");
  await ensureColumn('appearances', 'attendanceUpdatedBy', 'TEXT');
  await ensureColumn('appearances', 'attendanceUpdatedAt', 'TEXT');
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
  await ensureColumn('firm_settings', 'moduleSettingsJson', 'TEXT');
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
  await run('CREATE INDEX IF NOT EXISTS idx_appearance_prep_items_appearanceId ON appearance_prep_items(appearanceId)');
  await run('CREATE INDEX IF NOT EXISTS idx_appearance_prep_items_matterId ON appearance_prep_items(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_appearance_documents_appearanceId ON appearance_documents(appearanceId)');
  await run('CREATE INDEX IF NOT EXISTS idx_appearance_documents_documentId ON appearance_documents(documentId)');
  await run('CREATE INDEX IF NOT EXISTS idx_appearance_documents_matterId ON appearance_documents(matterId)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_appearance_documents_unique ON appearance_documents(appearanceId, documentId)');
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
  await run('CREATE INDEX IF NOT EXISTS idx_legal_deadline_rules_type_active ON legal_deadline_rules(ruleType, isActive)');
  await run('CREATE INDEX IF NOT EXISTS idx_legal_deadline_rules_jurisdiction_area ON legal_deadline_rules(jurisdiction, legalArea)');
  await run('CREATE INDEX IF NOT EXISTS idx_legal_deadline_rules_active ON legal_deadline_rules(isActive)');
  await run('CREATE INDEX IF NOT EXISTS idx_legal_deadline_suggestions_status ON legal_deadline_suggestions(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_legal_deadline_suggestions_matter_status ON legal_deadline_suggestions(matterId, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_legal_deadline_suggestions_rule_status ON legal_deadline_suggestions(ruleId, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_legal_deadline_suggestions_due_date ON legal_deadline_suggestions(suggestedDueDate)');
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
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_records_clientId ON retainer_records(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_records_matterId ON retainer_records(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_records_status ON retainer_records(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_records_active ON retainer_records(isActive)');
  await run('CREATE INDEX IF NOT EXISTS idx_matter_fee_plans_clientId ON matter_fee_plans(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_matter_fee_plans_matterId ON matter_fee_plans(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_matter_fee_plans_retainerId ON matter_fee_plans(retainerId)');
  await run('CREATE INDEX IF NOT EXISTS idx_matter_fee_plans_status ON matter_fee_plans(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_matter_fee_plans_active ON matter_fee_plans(isActive)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_ledger_entries_clientId ON retainer_ledger_entries(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_ledger_entries_matterId ON retainer_ledger_entries(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_ledger_entries_retainerId ON retainer_ledger_entries(retainerId)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_ledger_entries_feePlanId ON retainer_ledger_entries(feePlanId)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_ledger_entries_entryType ON retainer_ledger_entries(entryType)');
  await run('CREATE INDEX IF NOT EXISTS idx_retainer_ledger_entries_isVoided ON retainer_ledger_entries(isVoided)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_kyc_records_clientId ON client_kyc_records(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_kyc_records_status ON client_kyc_records(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_kyc_records_riskLevel ON client_kyc_records(riskLevel)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_kyc_records_active ON client_kyc_records(isActive)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_authority_records_clientId ON client_authority_records(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_authority_records_status ON client_authority_records(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_authority_records_basis ON client_authority_records(authorityBasis)');
  await run('CREATE INDEX IF NOT EXISTS idx_client_authority_records_active ON client_authority_records(isActive)');
  await run('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_clientId ON retainer_lifecycle_events(clientId)');
  await run('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_matterId ON retainer_lifecycle_events(matterId)');
  await run('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_retainerId ON retainer_lifecycle_events(retainerId)');
  await run('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_eventType ON retainer_lifecycle_events(eventType)');
  await run('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_status ON retainer_lifecycle_events(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_lifecycle_events_clientId_active ON retainer_lifecycle_events(clientId, isActive)');
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
  if (!passwordPolicy.ok) return res.status(400).json({ error: 'Password is required' });
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
  let moduleValidationResult = null;
  if (req.body.moduleSettings !== undefined) {
    const validation = normalizeModuleSettingsInput(req.body.moduleSettings);
    if (validation.error) return res.status(400).json({ error: validation.error });
    moduleValidationResult = validation;
    const currentSettings = await get('SELECT moduleSettingsJson FROM firm_settings WHERE id=?', ['default']);
    const current = resolveModuleSettings(currentSettings?.moduleSettingsJson);
    const merged = { ...current, ...validation.value };
    await run('UPDATE firm_settings SET moduleSettingsJson=? WHERE id=?', [JSON.stringify(merged), 'default']);
  }
  const fieldsUpdated = Object.keys(req.body).filter(k => k !== 'reminderSettings' && k !== 'moduleSettings');
  const metadata = { name: settings.name, fieldsUpdated };
  if (req.body.advocateBillingVisibility !== undefined && req.body.advocateBillingVisibility !== oldBillingVisibility) {
    metadata.advocateBillingVisibility = { old: oldBillingVisibility, new: Number(req.body.advocateBillingVisibility) };
  }
  if (moduleValidationResult && Object.keys(moduleValidationResult.value).length) {
    metadata.moduleSettings = { ...moduleValidationResult.value };
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
// Public OAuth availability endpoint — returns only safe booleans, no secrets.
app.get('/api/auth/oauth/availability', async (_req, res) => {
  const stateReady = Boolean(config.OAUTH_STATE_SECRET);
  res.json({
    google: stateReady && config.OAUTH_STAFF_ENABLED && Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
    microsoft: stateReady && config.OAUTH_STAFF_ENABLED && Boolean(config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET),
  });
});

app.get('/api/auth/oauth/google/start', async (req, res) => {
  if (!config.OAUTH_STAFF_ENABLED) return res.status(503).json({ error: 'Staff OAuth is not enabled.' });
  try {
    const state = signState('google');
    const url = googleOAuth.buildAuthorizationUrl(state);
    await recordAuditEvent(req, { action: 'oauth_login_started', entityType: 'oauth', metadata: { provider: 'google' } }).catch(() => {});
    res.json({ authorizationUrl: url });
  } catch (err) { res.status(503).json({ error: 'OAuth is not configured.' }); }
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
  } catch (err) { res.status(503).json({ error: 'OAuth is not configured.' }); }
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

// LOCAL-PILOT-FIX-2: lets the UI hide Connect buttons and show a clear local-pilot
// note instead of a confusing "OAuth is not configured" error after the click.
// Booleans only — never exposes secrets or their values.
app.get('/api/connected-accounts/availability', authenticate, requireStaff, async (_req, res) => {
  const stateReady = Boolean(config.OAUTH_STATE_SECRET);
  res.json({
    google: stateReady && Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
    microsoft: stateReady && Boolean(config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET),
  });
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

app.get('/api/hr/staff', requireAdmin, async (_req, res) => {
  const rows = await all(`
    SELECT
      u.id userId,
      u.fullName,
      u.email,
      u.role,
      u.isActive,
      p.id profileId,
      p.jobTitle,
      p.department,
      p.practiceTeam,
      p.employmentType,
      p.startDate,
      p.contractEndDate,
      p.supervisorUserId,
      p.workEmail,
      p.workPhone,
      p.hrStatus,
      p.createdAt profileCreatedAt,
      p.updatedAt profileUpdatedAt
    FROM users u
    LEFT JOIN hr_staff_profiles p ON p.userId=u.id
    WHERE u.role IN ('admin','advocate','assistant')
    ORDER BY u.fullName COLLATE NOCASE ASC, u.email COLLATE NOCASE ASC
  `);
  res.json(rows.map(row => ({ ...publicHrStaffUser(row), profile: publicHrProfileSummary(row) })));
});

app.get('/api/hr/staff/:userId/profile', requireAdmin, async (req, res) => {
  try {
    const staff = await getHrStaffUser(req.params.userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });
    const profile = await get('SELECT * FROM hr_staff_profiles WHERE userId=?', [staff.user.id]);
    res.json({ staff: publicHrStaffUser(staff.user), profile: publicHrProfile(profile) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/staff/:userId/profile', requireAdmin, async (req, res) => {
  try {
    const staff = await getHrStaffUser(req.params.userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });
    const existing = await get('SELECT id FROM hr_staff_profiles WHERE userId=?', [staff.user.id]);
    if (existing) return res.status(409).json({ error: 'HR profile already exists for this staff user' });
    const parsed = validateHrProfilePayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const supervisorError = await validateHrSupervisor(parsed.value.supervisorUserId);
    if (supervisorError) return res.status(400).json({ error: supervisorError });

    const id = genId('HRP');
    const now = new Date().toISOString();
    const values = HR_PROFILE_FIELDS.map(field => parsed.value[field] || '');
    await run(`INSERT INTO hr_staff_profiles (
      id,userId,jobTitle,department,practiceTeam,employmentType,startDate,contractEndDate,supervisorUserId,workEmail,workPhone,emergencyContactName,emergencyContactPhone,hrStatus,adminNotes,createdAt,updatedAt,createdBy,updatedBy
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id,
      staff.user.id,
      ...values,
      now,
      '',
      req.user.userId,
      '',
    ]);
    await recordAuditEvent(req, {
      action: 'hr_profile_created',
      entityType: 'hr_staff_profile',
      entityId: id,
      metadata: hrAuditMetadata(staff.user, parsed.changedFields),
    }).catch(() => {});
    const profile = await get('SELECT * FROM hr_staff_profiles WHERE id=?', [id]);
    res.status(201).json({ staff: publicHrStaffUser(staff.user), profile: publicHrProfile(profile) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/staff/:userId/profile', requireAdmin, async (req, res) => {
  try {
    const staff = await getHrStaffUser(req.params.userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });
    const existing = await get('SELECT * FROM hr_staff_profiles WHERE userId=?', [staff.user.id]);
    if (!existing) return res.status(404).json({ error: 'HR profile not found' });
    const parsed = validateHrProfilePayload(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (parsed.value.supervisorUserId !== undefined) {
      const supervisorError = await validateHrSupervisor(parsed.value.supervisorUserId);
      if (supervisorError) return res.status(400).json({ error: supervisorError });
    }

    const now = new Date().toISOString();
    const fields = Object.keys(parsed.value);
    const assignments = fields.map(field => `${field}=?`).join(',');
    const values = fields.map(field => parsed.value[field]);
    await run(`UPDATE hr_staff_profiles SET ${assignments}, updatedAt=?, updatedBy=? WHERE id=?`, [
      ...values,
      now,
      req.user.userId,
      existing.id,
    ]);
    await recordAuditEvent(req, {
      action: 'hr_profile_updated',
      entityType: 'hr_staff_profile',
      entityId: existing.id,
      metadata: hrAuditMetadata(staff.user, parsed.changedFields),
    }).catch(() => {});
    const profile = await get('SELECT * FROM hr_staff_profiles WHERE id=?', [existing.id]);
    res.json({ staff: publicHrStaffUser(staff.user), profile: publicHrProfile(profile) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- HR Document records (HR-29E) ---
// Admin-only. Stored separately from matter documents; never exposed to staff self-service or the client portal.

const HR_DOCUMENT_LIST_COLUMNS = `
  d.id, d.userId, d.documentType, d.title, d.fileName, d.mimeType, d.size,
  d.isActive, d.uploadedBy, d.uploadedAt, d.deletedBy, d.deletedAt, d.createdAt, d.updatedAt,
  u.fullName staffName, u.email staffEmail, u.role staffRole`;

app.get('/api/hr/documents', requireAdmin, async (req, res) => {
  try {
    const { userId, documentType, includeInactive } = req.query;
    const conditions = ["u.role IN ('admin','advocate','assistant')"];
    const params = [];
    if (userId) { conditions.push('d.userId = ?'); params.push(userId); }
    if (documentType) {
      if (!HR_DOCUMENT_TYPES.has(documentType)) return res.status(400).json({ error: 'Invalid documentType' });
      conditions.push('d.documentType = ?'); params.push(documentType);
    }
    const wantInactive = includeInactive === 'true' || includeInactive === '1';
    if (!wantInactive) conditions.push('d.isActive = 1');
    const rows = await all(
      `SELECT ${HR_DOCUMENT_LIST_COLUMNS}
       FROM hr_documents d
       JOIN users u ON u.id = d.userId
       WHERE ${conditions.join(' AND ')}
       ORDER BY d.uploadedAt DESC, d.createdAt DESC`,
      params,
    );
    res.json(rows.map(publicHrDocument));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/documents', requireAdmin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { userId, documentType, title, fileName, mimeType, contentBase64 } = body;

    const staff = await getHrStaffUser(userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });

    if (!HR_DOCUMENT_TYPES.has(documentType)) return res.status(400).json({ error: 'Invalid documentType' });
    if (typeof mimeType !== 'string' || !HR_DOCUMENT_MIME_TYPES.has(mimeType)) return res.status(400).json({ error: 'Invalid mimeType' });

    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) return res.status(400).json({ error: 'title is required' });
    if (cleanTitle.length > HR_DOCUMENT_TITLE_MAX) return res.status(400).json({ error: `title must not exceed ${HR_DOCUMENT_TITLE_MAX} characters` });

    const cleanFileName = typeof fileName === 'string' ? fileName.trim() : '';
    if (!cleanFileName) return res.status(400).json({ error: 'fileName is required' });
    if (cleanFileName.length > HR_DOCUMENT_FILENAME_MAX) return res.status(400).json({ error: `fileName must not exceed ${HR_DOCUMENT_FILENAME_MAX} characters` });

    let buffer;
    try {
      buffer = decodeAttachmentData({ data: contentBase64 });
    } catch (decodeErr) {
      return res.status(400).json({ error: decodeErr.message || 'Invalid document content' });
    }
    if (buffer.length > MAX_HR_DOCUMENT_BYTES) return res.status(413).json({ error: 'HR document exceeds the 10 MB limit' });

    const id = genId('HRD');
    const now = new Date().toISOString();
    const size = `${Math.max(1, Math.round(buffer.length / 1024))} KB`;
    await run(
      `INSERT INTO hr_documents (id, userId, documentType, title, fileName, mimeType, size, content, isActive, uploadedBy, uploadedAt, deletedBy, deletedAt, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, staff.user.id, documentType, cleanTitle, cleanFileName, mimeType, size, buffer, 1, req.user.userId, now, null, null, now, null],
    );
    await recordAuditEvent(req, {
      action: 'hr_document_uploaded',
      entityType: 'hr_document',
      entityId: id,
      metadata: { documentId: id, userId: staff.user.id, documentType, mimeType, size },
    }).catch(() => {});
    const row = await get(
      `SELECT ${HR_DOCUMENT_LIST_COLUMNS} FROM hr_documents d JOIN users u ON u.id = d.userId WHERE d.id = ?`,
      [id],
    );
    res.status(201).json(publicHrDocument(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hr/documents/:id/content', requireAdmin, async (req, res) => {
  try {
    const doc = await get('SELECT * FROM hr_documents WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'HR document not found' });
    if (!doc.isActive) return res.status(404).json({ error: 'HR document is inactive' });
    const content = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content || '');
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanDocumentName(doc.fileName || doc.title || doc.id)}"`);
    res.send(content);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/documents/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await get('SELECT * FROM hr_documents WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'HR document not found' });

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const updates = {};
    if (body.title !== undefined) {
      const cleanTitle = typeof body.title === 'string' ? body.title.trim() : '';
      if (!cleanTitle) return res.status(400).json({ error: 'title is required' });
      if (cleanTitle.length > HR_DOCUMENT_TITLE_MAX) return res.status(400).json({ error: `title must not exceed ${HR_DOCUMENT_TITLE_MAX} characters` });
      updates.title = cleanTitle;
    }
    if (body.documentType !== undefined) {
      if (!HR_DOCUMENT_TYPES.has(body.documentType)) return res.status(400).json({ error: 'Invalid documentType' });
      updates.documentType = body.documentType;
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean' && body.isActive !== 0 && body.isActive !== 1) return res.status(400).json({ error: 'isActive must be a boolean' });
      updates.isActive = body.isActive === true || body.isActive === 1 ? 1 : 0;
    }
    const fields = Object.keys(updates);
    if (!fields.length) return res.status(400).json({ error: 'No supported HR document fields supplied' });

    const now = new Date().toISOString();
    const assignments = fields.map(field => `${field} = ?`).join(', ');
    const values = fields.map(field => updates[field]);
    await run(`UPDATE hr_documents SET ${assignments}, updatedAt = ? WHERE id = ?`, [...values, now, doc.id]);
    await recordAuditEvent(req, {
      action: 'hr_document_updated',
      entityType: 'hr_document',
      entityId: doc.id,
      metadata: { documentId: doc.id, userId: doc.userId, documentType: updates.documentType || doc.documentType, changedFields: fields.join(',') },
    }).catch(() => {});
    const row = await get(
      `SELECT ${HR_DOCUMENT_LIST_COLUMNS} FROM hr_documents d JOIN users u ON u.id = d.userId WHERE d.id = ?`,
      [doc.id],
    );
    res.json(publicHrDocument(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/hr/documents/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await get('SELECT * FROM hr_documents WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'HR document not found' });
    const now = new Date().toISOString();
    await run(
      'UPDATE hr_documents SET isActive = 0, deletedBy = ?, deletedAt = ?, updatedAt = ? WHERE id = ?',
      [req.user.userId, now, now, doc.id],
    );
    await recordAuditEvent(req, {
      action: 'hr_document_deleted',
      entityType: 'hr_document',
      entityId: doc.id,
      metadata: { documentId: doc.id, userId: doc.userId, documentType: doc.documentType, mimeType: doc.mimeType, size: doc.size || '' },
    }).catch(() => {});
    const row = await get(
      `SELECT ${HR_DOCUMENT_LIST_COLUMNS} FROM hr_documents d JOIN users u ON u.id = d.userId WHERE d.id = ?`,
      [doc.id],
    );
    res.json(publicHrDocument(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- HR Contract records (HR-29E) ---
// Admin-only. No salary/allowance fields; notes are never written to audit metadata.

const HR_CONTRACT_SELECT = `
  c.*,
  u.fullName staffName, u.email staffEmail, u.role staffRole,
  hd.id docId, hd.documentType docType, hd.title docTitle, hd.fileName docFileName,
  hd.mimeType docMimeType, hd.size docSize, hd.isActive docIsActive`;

async function validateHrContractLinkedDocument(documentId, userId) {
  const doc = await get('SELECT id, userId, isActive FROM hr_documents WHERE id = ?', [documentId]);
  if (!doc) return 'documentId must reference an HR document';
  if (doc.userId !== userId) return 'documentId must reference an HR document for the same staff user';
  if (!doc.isActive) return 'documentId must reference an active HR document';
  return null;
}

app.get('/api/hr/contracts', requireAdmin, async (req, res) => {
  try {
    const { userId, status } = req.query;
    const conditions = [];
    const params = [];
    if (userId) { conditions.push('c.userId = ?'); params.push(userId); }
    if (status) {
      if (!HR_CONTRACT_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
      conditions.push('c.status = ?'); params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await all(
      `SELECT ${HR_CONTRACT_SELECT}
       FROM hr_contract_records c
       JOIN users u ON u.id = c.userId
       LEFT JOIN hr_documents hd ON hd.id = c.documentId
       ${where}
       ORDER BY c.createdAt DESC`,
      params,
    );
    res.json(rows.map(publicHrContract));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hr/contracts/:id', requireAdmin, async (req, res) => {
  try {
    const row = await get(
      `SELECT ${HR_CONTRACT_SELECT}
       FROM hr_contract_records c
       JOIN users u ON u.id = c.userId
       LEFT JOIN hr_documents hd ON hd.id = c.documentId
       WHERE c.id = ?`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Contract record not found' });
    res.json(publicHrContract(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/contracts', requireAdmin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { userId, contractType, status, documentId, notes } = body;

    const staff = await getHrStaffUser(userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });

    if (!HR_CONTRACT_TYPES.has(contractType)) return res.status(400).json({ error: 'Invalid contractType' });

    const contractStatus = status === undefined || status === null || status === '' ? 'active' : status;
    if (!HR_CONTRACT_STATUSES.has(contractStatus)) return res.status(400).json({ error: 'Invalid status' });

    const dates = {};
    for (const field of HR_CONTRACT_DATE_FIELDS) {
      const value = body[field];
      if (value === undefined || value === null || value === '') { dates[field] = ''; continue; }
      if (!isValidHrDate(value)) return res.status(400).json({ error: `${field} must be a valid YYYY-MM-DD date` });
      dates[field] = value.trim();
    }

    let cleanNotes = '';
    if (notes !== undefined && notes !== null) {
      if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
      cleanNotes = notes.trim();
      if (cleanNotes.length > HR_CONTRACT_NOTES_MAX) return res.status(400).json({ error: `notes must not exceed ${HR_CONTRACT_NOTES_MAX} characters` });
    }

    let linkedDocumentId = '';
    if (documentId) {
      const linkError = await validateHrContractLinkedDocument(documentId, staff.user.id);
      if (linkError) return res.status(400).json({ error: linkError });
      linkedDocumentId = documentId;
    }

    const id = genId('HRC');
    const now = new Date().toISOString();
    await run(
      `INSERT INTO hr_contract_records (id, userId, contractType, startDate, endDate, probationEndDate, renewalDate, status, documentId, notes, createdAt, updatedAt, createdBy, updatedBy)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, staff.user.id, contractType, dates.startDate, dates.endDate, dates.probationEndDate, dates.renewalDate, contractStatus, linkedDocumentId, cleanNotes, now, null, req.user.userId, null],
    );
    await recordAuditEvent(req, {
      action: 'hr_contract_recorded',
      entityType: 'hr_contract',
      entityId: id,
      metadata: hrContractAuditMetadata({ id, userId: staff.user.id, contractType, status: contractStatus, ...dates, documentId: linkedDocumentId }, staff.user),
    }).catch(() => {});
    const row = await get(
      `SELECT ${HR_CONTRACT_SELECT}
       FROM hr_contract_records c
       JOIN users u ON u.id = c.userId
       LEFT JOIN hr_documents hd ON hd.id = c.documentId
       WHERE c.id = ?`,
      [id],
    );
    res.status(201).json(publicHrContract(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/contracts/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await get('SELECT * FROM hr_contract_records WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Contract record not found' });

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const updates = {};

    if (body.contractType !== undefined) {
      if (!HR_CONTRACT_TYPES.has(body.contractType)) return res.status(400).json({ error: 'Invalid contractType' });
      updates.contractType = body.contractType;
    }
    if (body.status !== undefined) {
      if (!HR_CONTRACT_STATUSES.has(body.status)) return res.status(400).json({ error: 'Invalid status' });
      updates.status = body.status;
    }
    for (const field of HR_CONTRACT_DATE_FIELDS) {
      if (body[field] === undefined) continue;
      const value = body[field];
      if (value === null || value === '') { updates[field] = ''; continue; }
      if (!isValidHrDate(value)) return res.status(400).json({ error: `${field} must be a valid YYYY-MM-DD date` });
      updates[field] = value.trim();
    }
    if (body.notes !== undefined) {
      if (body.notes === null) { updates.notes = ''; }
      else if (typeof body.notes !== 'string') { return res.status(400).json({ error: 'notes must be a string' }); }
      else {
        const cleanNotes = body.notes.trim();
        if (cleanNotes.length > HR_CONTRACT_NOTES_MAX) return res.status(400).json({ error: `notes must not exceed ${HR_CONTRACT_NOTES_MAX} characters` });
        updates.notes = cleanNotes;
      }
    }
    if (body.documentId !== undefined) {
      if (body.documentId === null || body.documentId === '') {
        updates.documentId = '';
      } else {
        const linkError = await validateHrContractLinkedDocument(body.documentId, existing.userId);
        if (linkError) return res.status(400).json({ error: linkError });
        updates.documentId = body.documentId;
      }
    }

    const fields = Object.keys(updates);
    if (!fields.length) return res.status(400).json({ error: 'No supported contract fields supplied' });

    const now = new Date().toISOString();
    const assignments = fields.map(field => `${field} = ?`).join(', ');
    const values = fields.map(field => updates[field]);
    await run(`UPDATE hr_contract_records SET ${assignments}, updatedAt = ?, updatedBy = ? WHERE id = ?`, [...values, now, req.user.userId, existing.id]);

    const merged = { ...existing, ...updates };
    await recordAuditEvent(req, {
      action: 'hr_contract_updated',
      entityType: 'hr_contract',
      entityId: existing.id,
      metadata: hrContractAuditMetadata(merged, { id: existing.userId }),
    }).catch(() => {});
    const row = await get(
      `SELECT ${HR_CONTRACT_SELECT}
       FROM hr_contract_records c
       JOIN users u ON u.id = c.userId
       LEFT JOIN hr_documents hd ON hd.id = c.documentId
       WHERE c.id = ?`,
      [existing.id],
    );
    res.json(publicHrContract(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- HR Offboarding routes (HR-29F) ---
// Admin-only. Orchestrates matter-reassignment review, HR status update, checklist
// tracking, and optional account deactivation. Never deletes users or HR records.

app.get('/api/hr/offboarding', requireAdmin, async (req, res) => {
  try {
    const { status, userId } = req.query;
    const conditions = [];
    const params = [];
    if (status) {
      if (!HR_OFFBOARDING_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
      conditions.push('oc.status = ?'); params.push(status);
    }
    if (userId) { conditions.push('oc.userId = ?'); params.push(userId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await all(
      `SELECT ${HR_OFFBOARDING_CASE_SELECT} FROM hr_offboarding_cases oc JOIN users u ON u.id = oc.userId ${where} ORDER BY oc.createdAt DESC`,
      params,
    );
    res.json(rows.map(row => publicOffboardingCase(row)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hr/offboarding/:id', requireAdmin, async (req, res) => {
  try {
    const full = await loadFullOffboardingCase(req.params.id);
    if (!full) return res.status(404).json({ error: 'Offboarding case not found' });
    res.json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/offboarding', requireAdmin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { userId, exitType, exitDate, reasonCategory, notes } = body;

    const staff = await getHrStaffUser(userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });

    const existing = await get("SELECT id FROM hr_offboarding_cases WHERE userId = ? AND status IN ('open','in_progress')", [staff.user.id]);
    if (existing) return res.status(409).json({ error: 'An open offboarding case already exists for this staff user' });

    let cleanExitType = '';
    if (exitType !== undefined && exitType !== null) {
      if (typeof exitType !== 'string') return res.status(400).json({ error: 'exitType must be a string' });
      cleanExitType = exitType.trim();
      if (cleanExitType.length > HR_OFFBOARDING_EXITTYPE_MAX) return res.status(400).json({ error: `exitType must not exceed ${HR_OFFBOARDING_EXITTYPE_MAX} characters` });
    }
    let cleanExitDate = '';
    if (exitDate !== undefined && exitDate !== null && exitDate !== '') {
      if (!isValidHrDate(exitDate)) return res.status(400).json({ error: 'exitDate must be a valid YYYY-MM-DD date' });
      cleanExitDate = exitDate.trim();
    }
    let cleanReason = '';
    if (reasonCategory !== undefined && reasonCategory !== null && reasonCategory !== '') {
      if (!HR_OFFBOARDING_REASONS.has(reasonCategory)) return res.status(400).json({ error: 'Invalid reasonCategory' });
      cleanReason = reasonCategory;
    }
    let cleanNotes = '';
    if (notes !== undefined && notes !== null) {
      if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
      cleanNotes = notes.trim();
      if (cleanNotes.length > HR_OFFBOARDING_NOTES_MAX) return res.status(400).json({ error: `notes must not exceed ${HR_OFFBOARDING_NOTES_MAX} characters` });
    }

    const id = genId('HROB');
    const now = new Date().toISOString();
    await run(
      `INSERT INTO hr_offboarding_cases (id, userId, status, exitType, exitDate, reasonCategory, notes, startedBy, startedAt, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, staff.user.id, 'open', cleanExitType, cleanExitDate, cleanReason, cleanNotes, req.user.userId, now, now, null],
    );
    for (const [itemKey, label] of HR_OFFBOARDING_CHECKLIST_TEMPLATE) {
      await run(
        `INSERT INTO hr_offboarding_checklist_items (id, offboardingCaseId, itemKey, label, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)`,
        [genId('HROBI'), id, itemKey, label, 'pending', now, null],
      );
    }
    await recordAuditEvent(req, {
      action: 'staff_offboarding_started',
      entityType: 'hr_offboarding_case',
      entityId: id,
      metadata: offboardingAuditMetadata({ caseId: id, userId: staff.user.id, status: 'open', exitType: cleanExitType, reasonCategory: cleanReason, exitDate: cleanExitDate }),
    }).catch(() => {});
    const full = await loadFullOffboardingCase(id);
    res.status(201).json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/offboarding/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await get('SELECT * FROM hr_offboarding_cases WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Offboarding case not found' });
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return res.status(409).json({ error: 'Completed or cancelled offboarding cases cannot be modified' });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const updates = {};
    if (body.status !== undefined) {
      // Only open/in_progress transitions allowed here; completion/cancellation use dedicated routes.
      if (!['open', 'in_progress'].includes(body.status)) return res.status(400).json({ error: 'Use the complete or cancel routes to finalize a case' });
      updates.status = body.status;
    }
    if (body.exitType !== undefined) {
      if (body.exitType === null) updates.exitType = '';
      else if (typeof body.exitType !== 'string') return res.status(400).json({ error: 'exitType must be a string' });
      else { const v = body.exitType.trim(); if (v.length > HR_OFFBOARDING_EXITTYPE_MAX) return res.status(400).json({ error: `exitType must not exceed ${HR_OFFBOARDING_EXITTYPE_MAX} characters` }); updates.exitType = v; }
    }
    if (body.exitDate !== undefined) {
      if (body.exitDate === null || body.exitDate === '') updates.exitDate = '';
      else if (!isValidHrDate(body.exitDate)) return res.status(400).json({ error: 'exitDate must be a valid YYYY-MM-DD date' });
      else updates.exitDate = body.exitDate.trim();
    }
    if (body.reasonCategory !== undefined) {
      if (body.reasonCategory === null || body.reasonCategory === '') updates.reasonCategory = '';
      else if (!HR_OFFBOARDING_REASONS.has(body.reasonCategory)) return res.status(400).json({ error: 'Invalid reasonCategory' });
      else updates.reasonCategory = body.reasonCategory;
    }
    if (body.notes !== undefined) {
      if (body.notes === null) updates.notes = '';
      else if (typeof body.notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
      else { const v = body.notes.trim(); if (v.length > HR_OFFBOARDING_NOTES_MAX) return res.status(400).json({ error: `notes must not exceed ${HR_OFFBOARDING_NOTES_MAX} characters` }); updates.notes = v; }
    }

    const fields = Object.keys(updates);
    if (!fields.length) return res.status(400).json({ error: 'No supported offboarding fields supplied' });

    const now = new Date().toISOString();
    const assignments = fields.map(f => `${f} = ?`).join(', ');
    await run(`UPDATE hr_offboarding_cases SET ${assignments}, updatedAt = ? WHERE id = ?`, [...fields.map(f => updates[f]), now, existing.id]);
    await recordAuditEvent(req, {
      action: 'staff_offboarding_updated',
      entityType: 'hr_offboarding_case',
      entityId: existing.id,
      metadata: offboardingAuditMetadata({ caseId: existing.id, userId: existing.userId, status: updates.status || existing.status, exitType: updates.exitType !== undefined ? updates.exitType : existing.exitType, reasonCategory: updates.reasonCategory !== undefined ? updates.reasonCategory : existing.reasonCategory, exitDate: updates.exitDate !== undefined ? updates.exitDate : existing.exitDate }),
    }).catch(() => {});
    const full = await loadFullOffboardingCase(existing.id);
    res.json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/offboarding/:id/checklist/:itemId', requireAdmin, async (req, res) => {
  try {
    const caseRow = await get('SELECT * FROM hr_offboarding_cases WHERE id = ?', [req.params.id]);
    if (!caseRow) return res.status(404).json({ error: 'Offboarding case not found' });
    const item = await get('SELECT * FROM hr_offboarding_checklist_items WHERE id = ? AND offboardingCaseId = ?', [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });
    if (caseRow.status === 'completed' || caseRow.status === 'cancelled') {
      return res.status(409).json({ error: 'Completed or cancelled offboarding cases cannot be modified' });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { status, notes } = body;
    if (!HR_OFFBOARDING_CHECKLIST_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid checklist status' });
    let cleanNotes = item.notes || '';
    if (notes !== undefined) {
      if (notes === null) cleanNotes = '';
      else if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
      else { cleanNotes = notes.trim(); if (cleanNotes.length > HR_OFFBOARDING_NOTES_MAX) return res.status(400).json({ error: `notes must not exceed ${HR_OFFBOARDING_NOTES_MAX} characters` }); }
    }

    const now = new Date().toISOString();
    const completedBy = status === 'done' ? req.user.userId : null;
    const completedAt = status === 'done' ? now : null;
    await run(
      'UPDATE hr_offboarding_checklist_items SET status = ?, notes = ?, completedBy = ?, completedAt = ?, updatedAt = ? WHERE id = ?',
      [status, cleanNotes, completedBy, completedAt, now, item.id],
    );
    await recordAuditEvent(req, {
      action: 'staff_offboarding_checklist_updated',
      entityType: 'hr_offboarding_checklist_item',
      entityId: item.id,
      metadata: offboardingAuditMetadata({ caseId: caseRow.id, userId: caseRow.userId, itemKey: item.itemKey, itemStatus: status }),
    }).catch(() => {});
    const full = await loadFullOffboardingCase(caseRow.id);
    res.json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hr/offboarding/:id/assigned-matters', requireAdmin, async (req, res) => {
  try {
    const caseRow = await get('SELECT * FROM hr_offboarding_cases WHERE id = ?', [req.params.id]);
    if (!caseRow) return res.status(404).json({ error: 'Offboarding case not found' });
    const staffUser = await get('SELECT id, fullName, email, role FROM users WHERE id = ?', [caseRow.userId]);
    if (!staffUser) return res.status(404).json({ error: 'Staff user not found' });
    const fullName = staffUser.fullName || '';
    const placeholders = HR_OFFBOARDING_INACTIVE_STAGES.map(() => '?').join(',');

    const activeMatters = fullName
      ? await all(
          `SELECT m.id, m.reference, m.title, m.stage, m.assignedTo, c.name clientName
           FROM matters m LEFT JOIN clients c ON c.id = m.clientId
           WHERE m.assignedTo = ? AND COALESCE(m.stage,'') NOT IN (${placeholders})
           ORDER BY m.openDate DESC, m.reference`,
          [fullName, ...HR_OFFBOARDING_INACTIVE_STAGES],
        )
      : [];
    const closedOrOnHoldRow = fullName
      ? await get(`SELECT COUNT(*) AS cnt FROM matters WHERE assignedTo = ? AND COALESCE(stage,'') IN (${placeholders})`, [fullName, ...HR_OFFBOARDING_INACTIVE_STAGES])
      : { cnt: 0 };
    const paralegalRow = fullName
      ? await get('SELECT COUNT(*) AS cnt FROM matters WHERE paralegal = ?', [fullName])
      : { cnt: 0 };

    res.json({
      caseId: caseRow.id,
      userId: staffUser.id,
      staffName: fullName,
      activeAssignedMatters: activeMatters,
      activeAssignedCount: activeMatters.length,
      closedOrOnHoldAssignedCount: Number(closedOrOnHoldRow.cnt) || 0,
      paralegalReferenceCount: Number(paralegalRow.cnt) || 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/offboarding/:id/complete', requireAdmin, async (req, res) => {
  try {
    const caseRow = await get('SELECT * FROM hr_offboarding_cases WHERE id = ?', [req.params.id]);
    if (!caseRow) return res.status(404).json({ error: 'Offboarding case not found' });
    if (caseRow.status === 'completed') return res.status(409).json({ error: 'Offboarding case is already completed' });
    if (caseRow.status === 'cancelled') return res.status(409).json({ error: 'Cancelled offboarding cases cannot be completed' });

    const staffUser = await get('SELECT id, fullName, email, role, isActive FROM users WHERE id = ?', [caseRow.userId]);
    if (!staffUser) return res.status(404).json({ error: 'Staff user not found' });

    // Server-side re-check: block completion while active assigned matters remain.
    const activeMatterCount = await countActiveAssignedMatters(staffUser.fullName || '');
    if (activeMatterCount > 0) {
      return res.status(409).json({ error: `Reassign all active matters before completing offboarding (${activeMatterCount} remaining)`, activeMatterCount });
    }

    // Determine whether deactivation is requested via the checklist.
    const deactivateItem = await get("SELECT status FROM hr_offboarding_checklist_items WHERE offboardingCaseId = ? AND itemKey = 'deactivate_account'", [caseRow.id]);
    const wantsDeactivation = Boolean(deactivateItem && deactivateItem.status === 'done');

    // Apply deactivation safeguards BEFORE making any changes (so a blocked deactivation
    // does not partially complete the case).
    if (wantsDeactivation) {
      if (staffUser.id === req.user.userId) {
        return res.status(400).json({ error: 'You cannot deactivate your own account via offboarding' });
      }
      if (staffUser.role === 'admin') {
        const activeAdminCount = await get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND isActive = 1");
        if ((activeAdminCount?.count || 0) <= 1) {
          return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
        }
      }
    }

    const now = new Date().toISOString();
    let deactivated = false;

    // 1. Optional deactivation (offboarding path bumps tokenVersion to terminate live sessions;
    //    does NOT touch the shared toggle-active route).
    if (wantsDeactivation && staffUser.isActive !== 0) {
      await run('UPDATE users SET isActive = 0, tokenVersion = COALESCE(tokenVersion, 1) + 1 WHERE id = ?', [staffUser.id]);
      deactivated = true;
    }

    // 2. Set HR profile hrStatus = 'exited' (create a minimal profile if none exists).
    const profile = await get('SELECT id FROM hr_staff_profiles WHERE userId = ?', [staffUser.id]);
    if (profile) {
      await run('UPDATE hr_staff_profiles SET hrStatus = ?, updatedAt = ?, updatedBy = ? WHERE id = ?', ['exited', now, req.user.userId, profile.id]);
    } else {
      await run(
        `INSERT INTO hr_staff_profiles (id, userId, hrStatus, createdAt, updatedAt, createdBy, updatedBy) VALUES (?,?,?,?,?,?,?)`,
        [genId('HRP'), staffUser.id, 'exited', now, null, req.user.userId, null],
      );
    }

    // 3. Mark the case completed.
    await run('UPDATE hr_offboarding_cases SET status = ?, completedBy = ?, completedAt = ?, updatedAt = ? WHERE id = ?', ['completed', req.user.userId, now, now, caseRow.id]);

    await recordAuditEvent(req, {
      action: 'staff_offboarding_completed',
      entityType: 'hr_offboarding_case',
      entityId: caseRow.id,
      metadata: offboardingAuditMetadata({ caseId: caseRow.id, userId: staffUser.id, status: 'completed', activeMatterCount, deactivated }),
    }).catch(() => {});
    if (deactivated) {
      await recordAuditEvent(req, {
        action: 'user_deactivated_from_hr',
        entityType: 'user',
        entityId: staffUser.id,
        metadata: offboardingAuditMetadata({ caseId: caseRow.id, userId: staffUser.id, deactivated: true }),
      }).catch(() => {});
    }
    const full = await loadFullOffboardingCase(caseRow.id);
    res.json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/offboarding/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const caseRow = await get('SELECT * FROM hr_offboarding_cases WHERE id = ?', [req.params.id]);
    if (!caseRow) return res.status(404).json({ error: 'Offboarding case not found' });
    if (caseRow.status === 'completed') return res.status(409).json({ error: 'Completed offboarding cases cannot be cancelled' });
    if (caseRow.status === 'cancelled') return res.status(409).json({ error: 'Offboarding case is already cancelled' });

    const now = new Date().toISOString();
    await run('UPDATE hr_offboarding_cases SET status = ?, cancelledBy = ?, cancelledAt = ?, updatedAt = ? WHERE id = ?', ['cancelled', req.user.userId, now, now, caseRow.id]);
    await recordAuditEvent(req, {
      action: 'staff_offboarding_cancelled',
      entityType: 'hr_offboarding_case',
      entityId: caseRow.id,
      metadata: offboardingAuditMetadata({ caseId: caseRow.id, userId: caseRow.userId, status: 'cancelled' }),
    }).catch(() => {});
    const full = await loadFullOffboardingCase(caseRow.id);
    res.json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- HR Leave Request routes ---

// Admin routes
app.get('/api/hr/leave-requests', requireAdmin, async (req, res) => {
  try {
    const { status, userId } = req.query;
    const conditions = [];
    const params = [];
    if (status && ALLOWED_LEAVE_STATUSES.has(status)) {
      conditions.push('l.status=?');
      params.push(status);
    }
    if (userId && typeof userId === 'string' && userId.trim()) {
      conditions.push('l.userId=?');
      params.push(userId.trim());
    }
    let where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    where += ' AND u.role IN (\'admin\',\'advocate\',\'assistant\')';
    const rows = await all(`SELECT l.*, u.fullName, u.email, u.role
      FROM hr_leave_requests l
      JOIN users u ON u.id=l.userId
      ${where}
      ORDER BY l.requestedAt DESC`, params);
    res.json(rows.map(r => publicLeaveRequest(r)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hr/leave-requests/:id', requireAdmin, async (req, res) => {
  try {
    const row = await get(`SELECT l.*, u.fullName, u.email, u.role
      FROM hr_leave_requests l
      JOIN users u ON u.id=l.userId
      WHERE l.id=?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Leave request not found' });
    res.json(publicLeaveRequest(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/leave-requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    const row = await get('SELECT * FROM hr_leave_requests WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Leave request not found' });
    if (row.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be approved' });
    const decisionNote = normalizeDecisionNote(req.body?.decisionNote);
    if (decisionNote === null) return res.status(400).json({ error: 'decisionNote must not exceed 2000 characters' });
    const now = new Date().toISOString();
    await run('UPDATE hr_leave_requests SET status=?, decidedBy=?, decidedAt=?, decisionNote=?, updatedAt=? WHERE id=?', ['approved', req.user.userId, now, decisionNote, now, req.params.id]);
    await recordAuditEvent(req, {
      action: 'leave_approved',
      entityType: 'hr_leave_request',
      entityId: row.id,
      metadata: { requestId: row.id, userId: row.userId, leaveType: row.leaveType, startDate: row.startDate, endDate: row.endDate, days: row.days, status: 'approved' },
    }).catch(() => {});
    const updated = await get(`SELECT l.*, u.fullName, u.email, u.role FROM hr_leave_requests l JOIN users u ON u.id=l.userId WHERE l.id=?`, [req.params.id]);
    res.json(publicLeaveRequest(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/leave-requests/:id/reject', requireAdmin, async (req, res) => {
  try {
    const row = await get('SELECT * FROM hr_leave_requests WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Leave request not found' });
    if (row.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be rejected' });
    const decisionNote = normalizeDecisionNote(req.body?.decisionNote);
    if (decisionNote === null) return res.status(400).json({ error: 'decisionNote must not exceed 2000 characters' });
    const now = new Date().toISOString();
    await run('UPDATE hr_leave_requests SET status=?, decidedBy=?, decidedAt=?, decisionNote=?, updatedAt=? WHERE id=?', ['rejected', req.user.userId, now, decisionNote, now, req.params.id]);
    await recordAuditEvent(req, {
      action: 'leave_rejected',
      entityType: 'hr_leave_request',
      entityId: row.id,
      metadata: { requestId: row.id, userId: row.userId, leaveType: row.leaveType, startDate: row.startDate, endDate: row.endDate, days: row.days, status: 'rejected' },
    }).catch(() => {});
    const updated = await get(`SELECT l.*, u.fullName, u.email, u.role FROM hr_leave_requests l JOIN users u ON u.id=l.userId WHERE l.id=?`, [req.params.id]);
    res.json(publicLeaveRequest(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/leave-requests/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const row = await get('SELECT * FROM hr_leave_requests WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Leave request not found' });
    if (row.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    const now = new Date().toISOString();
    await run('UPDATE hr_leave_requests SET status=?, cancelledBy=?, cancelledAt=?, updatedAt=? WHERE id=?', ['cancelled', req.user.userId, now, now, req.params.id]);
    await recordAuditEvent(req, {
      action: 'leave_cancelled',
      entityType: 'hr_leave_request',
      entityId: row.id,
      metadata: { requestId: row.id, userId: row.userId, leaveType: row.leaveType, startDate: row.startDate, endDate: row.endDate, days: row.days, status: 'cancelled' },
    }).catch(() => {});
    const updated = await get(`SELECT l.*, u.fullName, u.email, u.role FROM hr_leave_requests l JOIN users u ON u.id=l.userId WHERE l.id=?`, [req.params.id]);
    res.json(publicLeaveRequest(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Self-service routes
app.get('/api/hr/me/leave-requests', requireStaff, async (req, res) => {
  try {
    const rows = await all(`SELECT l.*, u.fullName, u.email, u.role
      FROM hr_leave_requests l
      JOIN users u ON u.id=l.userId
      WHERE l.userId=?
      ORDER BY l.requestedAt DESC`, [req.user.userId]);
    res.json(rows.map(r => publicLeaveRequestSummary(r)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/me/leave-requests', requireStaff, async (req, res) => {
  try {
    const body = req.body || {};
    const userId = req.user.userId;

    const leaveType = normalizeLeaveType(body.leaveType);
    if (!leaveType) return res.status(400).json({ error: 'Invalid leaveType. Allowed: ' + [...ALLOWED_LEAVE_TYPES].join(', ') });

    const startDate = normalizeIsoDate(body.startDate);
    if (!startDate) return res.status(400).json({ error: 'startDate is required and must be YYYY-MM-DD' });

    const endDate = normalizeIsoDate(body.endDate);
    if (!endDate) return res.status(400).json({ error: 'endDate is required and must be YYYY-MM-DD' });

    if (endDate < startDate) return res.status(400).json({ error: 'endDate must be on or after startDate' });

    const days = calculateLeaveDays(startDate, endDate);

    const reason = normalizeLeaveReason(body.reason);
    if (reason === null) return res.status(400).json({ error: 'reason must not exceed 2000 characters' });

    const id = genId('LVR');
    const now = new Date().toISOString();
    await run(`INSERT INTO hr_leave_requests (id,userId,leaveType,startDate,endDate,days,reason,status,requestedAt,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, userId, leaveType, startDate, endDate, days, reason, 'pending', now, now, '']);

    await recordAuditEvent(req, {
      action: 'leave_requested',
      entityType: 'hr_leave_request',
      entityId: id,
      metadata: { requestId: id, userId, leaveType, startDate, endDate, days, status: 'pending' },
    }).catch(() => {});

    const row = await get(`SELECT l.*, u.fullName, u.email, u.role FROM hr_leave_requests l JOIN users u ON u.id=l.userId WHERE l.id=?`, [id]);
    res.status(201).json(publicLeaveRequest(row));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hr/me/leave-requests/:id/cancel', requireStaff, async (req, res) => {
  try {
    const row = await get('SELECT * FROM hr_leave_requests WHERE id=? AND userId=?', [req.params.id, req.user.userId]);
    if (!row) return res.status(404).json({ error: 'Leave request not found' });
    if (row.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    const now = new Date().toISOString();
    await run('UPDATE hr_leave_requests SET status=?, cancelledBy=?, cancelledAt=?, updatedAt=? WHERE id=?', ['cancelled', req.user.userId, now, now, req.params.id]);
    await recordAuditEvent(req, {
      action: 'leave_cancelled',
      entityType: 'hr_leave_request',
      entityId: row.id,
      metadata: { requestId: row.id, userId: row.userId, leaveType: row.leaveType, startDate: row.startDate, endDate: row.endDate, days: row.days, status: 'cancelled' },
    }).catch(() => {});
    const updated = await get(`SELECT l.*, u.fullName, u.email, u.role FROM hr_leave_requests l JOIN users u ON u.id=l.userId WHERE l.id=?`, [req.params.id]);
    res.json(publicLeaveRequest(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- HR Leave Balances and Dashboard ---

const ALLOWED_LEAVE_TYPES_ARRAY = ['annual','sick','compassionate','maternity','paternity','study_exam','unpaid','other'];

function validateYear(year) {
  const y = parseInt(year, 10);
  if (isNaN(y) || y < 2000 || y > 2100) return null;
  return y;
}

async function computeLeaveBalance(userId, leaveType, year) {
  const entitlement = await get('SELECT entitlementDays FROM hr_leave_entitlements WHERE userId=? AND leaveType=? AND year=?', [userId, leaveType, year]);
  const entitlementDays = entitlement ? entitlement.entitlementDays : 0;

  const adjRow = await get('SELECT COALESCE(SUM(days),0) AS total FROM hr_leave_balance_adjustments WHERE userId=? AND leaveType=? AND year=?', [userId, leaveType, year]);
  const adjustmentDays = adjRow ? adjRow.total : 0;

  const approvedRow = await get("SELECT COALESCE(SUM(days),0) AS total FROM hr_leave_requests WHERE userId=? AND leaveType=? AND status='approved' AND CAST(strftime('%Y',startDate) AS INTEGER)=?", [userId, leaveType, year]);
  const approvedUsedDays = approvedRow ? approvedRow.total : 0;

  const pendingRow = await get("SELECT COALESCE(SUM(days),0) AS total FROM hr_leave_requests WHERE userId=? AND leaveType=? AND status='pending' AND CAST(strftime('%Y',startDate) AS INTEGER)=?", [userId, leaveType, year]);
  const pendingRequestedDays = pendingRow ? pendingRow.total : 0;

  const remaining = entitlementDays + adjustmentDays - approvedUsedDays;
  const projectedRemaining = remaining - pendingRequestedDays;

  return { entitlementDays, adjustmentDays, approvedUsedDays, pendingRequestedDays, remainingDays: remaining, projectedRemainingDays: projectedRemaining };
}

async function getHrStaffUserOrReject(userId) {
  const user = await get('SELECT id,email,fullName,role,isActive FROM users WHERE id=?', [userId]);
  if (!user) return { error: 'User not found', status: 404 };
  if (!HR_STAFF_ROLES.has(user.role)) return { error: 'User is not a staff member', status: 403 };
  return { user };
}

// Admin: Dashboard
app.get('/api/hr/dashboard', requireAdmin, async (req, res) => {
  try {
    const year = validateYear(req.query.year || new Date().getFullYear());
    if (!year) return res.status(400).json({ error: 'Invalid year. Must be between 2000 and 2100.' });

    const staffCountRow = await get("SELECT COUNT(*) AS count FROM users WHERE role IN ('admin','advocate','assistant')");
    const staffCount = staffCountRow ? staffCountRow.count : 0;

    const activeStaffCountRow = await get("SELECT COUNT(*) AS count FROM users WHERE role IN ('admin','advocate','assistant') AND isActive=1");
    const activeStaffCount = activeStaffCountRow ? activeStaffCountRow.count : 0;

    const staffWithoutProfilesRow = await get("SELECT COUNT(*) AS count FROM users WHERE role IN ('admin','advocate','assistant') AND id NOT IN (SELECT userId FROM hr_staff_profiles)");
    const staffWithoutProfiles = staffWithoutProfilesRow ? staffWithoutProfilesRow.count : 0;

    const pendingLeaveCountRow = await get("SELECT COUNT(*) AS count FROM hr_leave_requests WHERE status='pending'");
    const pendingLeaveCount = pendingLeaveCountRow ? pendingLeaveCountRow.count : 0;

    const todayStr = new Date().toISOString().slice(0, 10);
    const onLeaveTodayRow = await get("SELECT COUNT(*) AS count FROM hr_leave_requests WHERE status='approved' AND startDate<=? AND endDate>=?", [todayStr, todayStr]);
    const staffCurrentlyOnLeave = onLeaveTodayRow ? onLeaveTodayRow.count : 0;

    const upcomingApprovedRow = await get("SELECT COUNT(*) AS count FROM hr_leave_requests WHERE status='approved' AND startDate>?", [todayStr]);
    const upcomingApprovedLeaveCount = upcomingApprovedRow ? upcomingApprovedRow.count : 0;

    const lowBalanceRows = await all(`SELECT e.userId, e.leaveType, e.year, e.entitlementDays,
      COALESCE((SELECT SUM(days) FROM hr_leave_balance_adjustments WHERE userId=e.userId AND leaveType=e.leaveType AND year=e.year),0) AS adjDays,
      COALESCE((SELECT SUM(days) FROM hr_leave_requests WHERE userId=e.userId AND leaveType=e.leaveType AND status='approved' AND CAST(strftime('%Y',startDate) AS INTEGER)=e.year),0) AS usedDays
      FROM hr_leave_entitlements e WHERE e.leaveType='annual'`);
    let lowAnnualBalanceCount = 0;
    for (const r of lowBalanceRows) {
      const remaining = r.entitlementDays + r.adjDays - r.usedDays;
      if (remaining <= 5) lowAnnualBalanceCount++;
    }

    const hrStatusRows = await all("SELECT hrStatus, COUNT(*) AS count FROM hr_staff_profiles GROUP BY hrStatus");
    const hrStatusCounts = {};
    for (const r of hrStatusRows) {
      hrStatusCounts[r.hrStatus] = r.count;
    }

    const recentPending = await all(`SELECT l.id, l.leaveType, l.startDate, l.endDate, l.days, l.status, l.requestedAt, u.fullName, u.email, u.role
      FROM hr_leave_requests l JOIN users u ON u.id=l.userId WHERE l.status='pending' ORDER BY l.requestedAt DESC LIMIT 20`);

    res.json({
      staffCount,
      activeStaffCount,
      staffWithoutProfiles,
      pendingLeaveCount,
      staffCurrentlyOnLeave,
      upcomingApprovedLeaveCount,
      lowAnnualBalanceCount,
      hrStatusCounts,
      recentPendingLeaveRequests: recentPending.map(r => ({
        id: r.id, leaveType: r.leaveType, startDate: r.startDate, endDate: r.endDate,
        days: r.days, status: r.status, requestedAt: r.requestedAt,
        fullName: r.fullName, email: r.email, role: r.role,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: List computed leave balances
app.get('/api/hr/leave-balances', requireAdmin, async (req, res) => {
  try {
    const year = validateYear(req.query.year || new Date().getFullYear());
    if (!year) return res.status(400).json({ error: 'Invalid year. Must be between 2000 and 2100.' });

    const { userId, leaveType } = req.query;
    let users;
    if (userId) {
      const u = await get('SELECT id,email,fullName,role,isActive FROM users WHERE id=?', [userId]);
      if (!u || !HR_STAFF_ROLES.has(u.role)) return res.status(404).json({ error: 'Staff user not found' });
      users = [u];
    } else {
      users = await all("SELECT id,email,fullName,role,isActive FROM users WHERE role IN ('admin','advocate','assistant') ORDER BY fullName COLLATE NOCASE ASC");
    }

    const leaveTypes = leaveType ? [leaveType] : ALLOWED_LEAVE_TYPES_ARRAY;
    const results = [];
    for (const u of users) {
      for (const lt of leaveTypes) {
        if (!ALLOWED_LEAVE_TYPES.has(lt)) continue;
        const balance = await computeLeaveBalance(u.id, lt, year);
        results.push({ userId: u.id, fullName: u.fullName, email: u.email, role: u.role, leaveType: lt, year, ...balance });
      }
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Set/upsert entitlement
app.put('/api/hr/leave-entitlements/:userId/:leaveType/:year', requireAdmin, async (req, res) => {
  try {
    const { userId, leaveType: rawLeaveType, year: rawYear } = req.params;
    const staff = await getHrStaffUserOrReject(userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });

    const leaveType = normalizeLeaveType(rawLeaveType);
    if (!leaveType) return res.status(400).json({ error: 'Invalid leaveType. Allowed: ' + ALLOWED_LEAVE_TYPES_ARRAY.join(', ') });

    const year = validateYear(rawYear);
    if (!year) return res.status(400).json({ error: 'Invalid year. Must be between 2000 and 2100.' });

    const entitlementDays = Number(req.body.entitlementDays);
    if (isNaN(entitlementDays) || entitlementDays < 0 || entitlementDays > 365) {
      return res.status(400).json({ error: 'entitlementDays must be a number between 0 and 365' });
    }

    const now = new Date().toISOString();
    const existing = await get('SELECT id FROM hr_leave_entitlements WHERE userId=? AND leaveType=? AND year=?', [userId, leaveType, year]);
    let rowId;
    if (existing) {
      await run('UPDATE hr_leave_entitlements SET entitlementDays=?, updatedAt=?, updatedBy=? WHERE id=?', [entitlementDays, now, req.user.userId, existing.id]);
      rowId = existing.id;
    } else {
      rowId = genId('HLE');
      await run('INSERT INTO hr_leave_entitlements (id,userId,leaveType,year,entitlementDays,createdAt,updatedAt,createdBy,updatedBy) VALUES (?,?,?,?,?,?,?,?,?)', [rowId, userId, leaveType, year, entitlementDays, now, '', req.user.userId, '']);
    }

    await recordAuditEvent(req, {
      action: 'leave_entitlement_set',
      entityType: 'hr_leave_entitlement',
      entityId: rowId,
      metadata: { userId, leaveType, year, entitlementDays, rowId },
    }).catch(() => {});

    const balance = await computeLeaveBalance(userId, leaveType, year);
    const user = await get('SELECT id,email,fullName,role FROM users WHERE id=?', [userId]);
    res.json({ userId, fullName: user.fullName, email: user.email, role: user.role, leaveType, year, ...balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Create balance adjustment
app.post('/api/hr/leave-balance-adjustments', requireAdmin, async (req, res) => {
  try {
    const { userId, leaveType: rawLeaveType, year: rawYear, days, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const staff = await getHrStaffUserOrReject(userId);
    if (staff.error) return res.status(staff.status).json({ error: staff.error });

    const leaveType = normalizeLeaveType(rawLeaveType);
    if (!leaveType) return res.status(400).json({ error: 'Invalid leaveType. Allowed: ' + ALLOWED_LEAVE_TYPES_ARRAY.join(', ') });

    const year = validateYear(rawYear);
    if (!year) return res.status(400).json({ error: 'Invalid year. Must be between 2000 and 2100.' });

    const daysNum = Number(days);
    if (isNaN(daysNum) || daysNum === 0) return res.status(400).json({ error: 'days must be a non-zero number' });
    if (daysNum < -365 || daysNum > 365) return res.status(400).json({ error: 'days must be between -365 and 365' });

    if (reason !== undefined && reason !== null && typeof reason === 'string' && reason.length > 1000) {
      return res.status(400).json({ error: 'reason must not exceed 1000 characters' });
    }

    const now = new Date().toISOString();
    const id = genId('HLB');
    await run('INSERT INTO hr_leave_balance_adjustments (id,userId,leaveType,year,days,reason,createdAt,createdBy) VALUES (?,?,?,?,?,?,?,?)',
      [id, userId, leaveType, year, daysNum, reason || '', now, req.user.userId]);

    await recordAuditEvent(req, {
      action: 'leave_balance_adjusted',
      entityType: 'hr_leave_balance_adjustment',
      entityId: id,
      metadata: { userId, leaveType, year, days: daysNum, adjustmentId: id },
    }).catch(() => {});

    const balance = await computeLeaveBalance(userId, leaveType, year);
    const user = await get('SELECT id,email,fullName,role FROM users WHERE id=?', [userId]);
    res.json({ userId, fullName: user.fullName, email: user.email, role: user.role, leaveType, year, ...balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Self-service: My leave balances
app.get('/api/hr/me/leave-balances', requireStaff, async (req, res) => {
  try {
    if (req.user.role === 'client') return res.status(403).json({ error: 'Clients cannot access leave balances' });
    const year = validateYear(req.query.year || new Date().getFullYear());
    if (!year) return res.status(400).json({ error: 'Invalid year. Must be between 2000 and 2100.' });

    const userId = req.user.userId;
    const results = [];
    for (const lt of ALLOWED_LEAVE_TYPES_ARRAY) {
      const balance = await computeLeaveBalance(userId, lt, year);
      results.push({ leaveType: lt, year, ...balance });
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    if (!passwordPolicy.ok) return res.status(400).json({ error: 'Password is required' });
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
    if (!passwordPolicy.ok) return res.status(400).json({ error: 'Password is required' });
    if (!['advocate', 'assistant', 'admin', 'client'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role === 'client' && !clientId) return res.status(400).json({ error: 'Client users must be linked to a client record' });
    if (role === 'client') {
      const linkedClient = await get('SELECT id FROM clients WHERE id=?', [clientId]);
      if (!linkedClient) return res.status(400).json({ error: 'Linked client not found' });
    }
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
// CLIENT-31C: concise, staff-only, READ-ONLY client snapshot aggregated from
// existing data only (no schema/tables/writes). Advocates are scoped by the
// existing canAccessClient model and billing figures honour isBillingVisibleFor.
app.get('/api/clients/:id/snapshot', requireStaff, async (req, res) => {
  const clientId = req.params.id;
  const clientRow = await get('SELECT * FROM clients WHERE id=?', [clientId]);
  if (!clientRow) return res.status(404).json({ error: 'Client not found' });
  if (!(await canAccessClient(req, clientId))) {
    await recordAuditEvent(req, { action: 'forbidden_client_access', entityType: 'client', entityId: clientId, clientId, metadata: { reason: 'insufficient permissions', route: 'client_snapshot' } }).catch(() => {});
    return res.status(403).json({ error: 'Client access denied' });
  }

  const todayDate = today();
  const matters = await all('SELECT id, title, stage FROM matters WHERE clientId=?', [clientId]);
  const matterIds = matters.map(m => m.id);
  const matterTitleById = new Map(matters.map(m => [m.id, m.title || '']));
  const matterPlaceholders = matterIds.map(() => '?').join(',');
  const activeCount = matters.filter(m => m.stage !== 'Closed' && m.stage !== 'On Hold').length;
  const totalCount = matters.length;

  // Next appearance (court date) across this client's matters, today or later.
  let nextAppearance = null;
  if (matterIds.length) {
    const ap = await get(`SELECT a.id, a.matterId, a.title, a.type, a.date, a.time, m.court court
      FROM appearances a JOIN matters m ON m.id=a.matterId
      WHERE a.matterId IN (${matterPlaceholders}) AND a.date >= ?
      ORDER BY a.date ASC, a.time ASC LIMIT 1`, [...matterIds, todayDate]);
    if (ap) {
      nextAppearance = {
        id: ap.id,
        matterId: ap.matterId,
        matterTitle: matterTitleById.get(ap.matterId) || '',
        date: ap.date || '',
        time: ap.time || '',
        court: ap.court || '',
        purpose: ap.title || ap.type || '',
      };
    }
  }

  // Open deadlines (status != 'Done'), scoped by matter OR client linkage.
  const deadlineWhere = matterIds.length
    ? `(clientId=? OR matterId IN (${matterPlaceholders}))`
    : 'clientId=?';
  const deadlineParams = matterIds.length ? [clientId, ...matterIds] : [clientId];
  const openDeadlineRows = await all(`SELECT id, matterId, title, dueDate, status FROM deadlines
    WHERE status != 'Done' AND ${deadlineWhere}
    ORDER BY dueDate ASC`, deadlineParams);
  const seenDeadlineIds = new Set();
  const openDeadlines = openDeadlineRows.filter(d => {
    if (seenDeadlineIds.has(d.id)) return false;
    seenDeadlineIds.add(d.id);
    return true;
  });
  const openDeadlinesCount = openDeadlines.length;
  const nextDeadlineRow = openDeadlines[0] || null;
  const nextDeadline = nextDeadlineRow ? {
    id: nextDeadlineRow.id,
    matterId: nextDeadlineRow.matterId || '',
    matterTitle: matterTitleById.get(nextDeadlineRow.matterId) || '',
    title: nextDeadlineRow.title || '',
    dueDate: nextDeadlineRow.dueDate || '',
    priority: null, // deadlines table has no priority column today
    status: nextDeadlineRow.status || 'Open',
  } : null;

  // Pending client document requests.
  const docReqWhere = matterIds.length
    ? `(clientId=? OR matterId IN (${matterPlaceholders}))`
    : 'clientId=?';
  const docReqRow = await get(`SELECT COUNT(*) count FROM document_requests
    WHERE status='pending' AND ${docReqWhere}`, deadlineParams);
  const pendingDocumentRequestsCount = Number(docReqRow?.count || 0);

  // Billing rollup (masked for advocates when firm disables billing visibility).
  const billingVisible = await isBillingVisibleFor(req);
  const invoiceWhere = matterIds.length
    ? `(clientId=? OR matterId IN (${matterPlaceholders}))`
    : 'clientId=?';
  const invoiceRows = await all(`SELECT id, amount, status, dueDate FROM invoices WHERE ${invoiceWhere}`, deadlineParams);
  const seenInvoiceIds = new Set();
  let outstandingBalance = 0;
  let overdueInvoiceCount = 0;
  for (const inv of invoiceRows) {
    if (seenInvoiceIds.has(inv.id)) continue;
    seenInvoiceIds.add(inv.id);
    const summary = await invoicePaymentSummary(inv.id, inv.amount);
    outstandingBalance += summary.balance;
    // Derived-overdue mirrors the client UI isInvoiceOverdue: unpaid + past due.
    if (inv.status !== 'Paid' && inv.dueDate && inv.dueDate < todayDate && summary.balance > 0) {
      overdueInvoiceCount += 1;
    }
  }
  outstandingBalance = Math.round(outstandingBalance * 100) / 100;

  const proofRow = await get(`SELECT COUNT(*) count FROM payment_proofs
    WHERE status='Pending' AND ${invoiceWhere}`, deadlineParams);
  const pendingPaymentProofCount = Number(proofRow?.count || 0);

  const billing = billingVisible
    ? { visible: true, outstandingBalance, overdueInvoiceCount, pendingPaymentProofCount }
    : { visible: false, outstandingBalance: null, overdueInvoiceCount: null, pendingPaymentProofCount: null };

  // Recent documents — safe metadata only (never content/BLOB/base64).
  let recentDocuments = [];
  if (matterIds.length) {
    const docs = await all(`SELECT id, matterId, name, displayName, type, mimeType, date, source, clientVisible
      FROM documents
      WHERE matterId IN (${matterPlaceholders}) AND deletedAt IS NULL
      ORDER BY date DESC LIMIT 5`, matterIds);
    recentDocuments = docs.map(d => ({
      id: d.id,
      matterId: d.matterId || '',
      matterTitle: matterTitleById.get(d.matterId) || '',
      name: d.name || '',
      displayName: d.displayName || '',
      type: d.type || '',
      mimeType: d.mimeType || '',
      date: d.date || '',
      source: d.source || '',
      clientVisible: Number(d.clientVisible || 0) === 1,
    }));
  }

  // Attention flags — derived only from data already gathered above.
  const conflictCleared = Number(clientRow.conflictCleared || 0) === 1;
  const attentionFlags = [];
  if (billingVisible && overdueInvoiceCount > 0) {
    attentionFlags.push({ key: 'overdue_invoices', label: 'Overdue invoices', severity: 'danger', detail: `${overdueInvoiceCount} invoice(s) past due` });
  }
  if (billingVisible && outstandingBalance > 0) {
    attentionFlags.push({ key: 'unpaid_fees', label: 'Unpaid fees', severity: 'warning', detail: `${money(outstandingBalance)} outstanding` });
  }
  if (nextDeadline && nextDeadline.dueDate && nextDeadline.dueDate <= addDays(7)) {
    attentionFlags.push({ key: 'upcoming_deadline', label: 'Upcoming deadline', severity: 'warning', detail: `${nextDeadline.title || 'Deadline'} due ${nextDeadline.dueDate}` });
  }
  if (billingVisible && pendingPaymentProofCount > 0) {
    attentionFlags.push({ key: 'pending_payment_proof', label: 'Payment proof to review', severity: 'info', detail: `${pendingPaymentProofCount} awaiting review` });
  }
  if (pendingDocumentRequestsCount > 0) {
    attentionFlags.push({ key: 'pending_document_request', label: 'Pending document request', severity: 'info', detail: `${pendingDocumentRequestsCount} awaiting client` });
  }
  if (!conflictCleared) {
    attentionFlags.push({ key: 'conflict_not_cleared', label: 'Conflict not cleared', severity: 'warning', detail: 'Conflict check not recorded as cleared' });
  }
  if (activeCount === 0) {
    attentionFlags.push({ key: 'no_active_matter', label: 'No active matter', severity: 'info', detail: 'No active matters for this client' });
  }

  // RET-31D: retainer intake snapshot (module-gated).
  let retainerBlock = { visible: false };
  if (await isModuleEnabled('retainerManagement')) {
    const activeRetainers = await all(`SELECT id, matterId, status, engagementType, engagementStartDate, signedDate
      FROM retainer_records WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC`, [clientId]);
    const latest = activeRetainers.length ? activeRetainers[0] : null;
    const retainerFlags = [];
    if (latest && latest.status !== 'signed') {
      retainerFlags.push({ key: 'unsigned_retainer', label: 'Unsigned retainer', severity: 'warning', detail: `Latest retainer (${latest.id.slice(0,8)}…) is ${latest.status}` });
    }
    if (activeCount > 0 && !latest) {
      retainerFlags.push({ key: 'no_retainer', label: 'No retainer', severity: 'info', detail: 'Active matters exist but no active retainer record' });
    }
    retainerBlock = {
      visible: true,
      activeCount: activeRetainers.length,
      latest: latest ? {
        id: latest.id,
        matterId: latest.matterId || '',
        matterTitle: matterTitleById.get(latest.matterId) || '',
        status: latest.status,
        engagementType: latest.engagementType || '',
        engagementStartDate: latest.engagementStartDate || '',
        signedDate: latest.signedDate || '',
      } : null,
      flags: retainerFlags,
    };
  }

  // RET-31E: matter fee plan snapshot (module-gated, read-only; no billing computation).
  let feePlanBlock = { visible: false };
  if (await isModuleEnabled('retainerManagement')) {
    const activeFeePlans = await all(`SELECT id, matterId, feeType, status, currency, estimatedAmount, hourlyRate, capAmount, depositRequired, billingFrequency, vatTreatment
      FROM matter_fee_plans WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC`, [clientId]);
    const latestFeePlan = activeFeePlans.length ? activeFeePlans[0] : null;
    feePlanBlock = {
      visible: true,
      activeCount: activeFeePlans.length,
      latest: latestFeePlan ? {
        id: latestFeePlan.id,
        matterId: latestFeePlan.matterId || '',
        matterTitle: matterTitleById.get(latestFeePlan.matterId) || '',
        feeType: latestFeePlan.feeType || '',
        status: latestFeePlan.status || '',
        currency: latestFeePlan.currency || 'KES',
        estimatedAmount: feePlanNumOrNull(latestFeePlan.estimatedAmount),
        hourlyRate: feePlanNumOrNull(latestFeePlan.hourlyRate),
        capAmount: feePlanNumOrNull(latestFeePlan.capAmount),
        depositRequired: feePlanNumOrNull(latestFeePlan.depositRequired),
        billingFrequency: latestFeePlan.billingFrequency || '',
        vatTreatment: latestFeePlan.vatTreatment || '',
      } : null,
    };
  }

  // RET-31F: retainer ledger snapshot summary (double module-gated; planning ledger only,
  // computed from entries — never reads/writes matters.retainerBalance).
  let ledgerBlock = { visible: false };
  if ((await isModuleEnabled('retainerManagement')) && (await isModuleEnabled('retainerLedger'))) {
    const ledgerRows = await all('SELECT amount, currency, direction, isVoided FROM retainer_ledger_entries WHERE clientId=?', [clientId]);
    ledgerBlock = { visible: true, ...computeLedgerSummary(ledgerRows) };
  }

  // RET-31G: client KYC/CDD snapshot summary (module-gated; non-sensitive fields only).
  let kycBlock = { visible: false };
  if (await isModuleEnabled('kycCdd')) {
    const activeKyc = await all(`SELECT id, status, clientCategory, riskLevel, verificationDate, expiryDate
      FROM client_kyc_records WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC`, [clientId]);
    const latestKyc = activeKyc.length ? activeKyc[0] : null;
    kycBlock = {
      visible: true,
      activeCount: activeKyc.length,
      latest: latestKyc ? {
        id: latestKyc.id,
        status: latestKyc.status || 'not_started',
        clientCategory: latestKyc.clientCategory || '',
        riskLevel: latestKyc.riskLevel || '',
        verificationDate: latestKyc.verificationDate || '',
        expiryDate: latestKyc.expiryDate || '',
      } : null,
    };
  }

  // RET-31H: client authority snapshot summary (module-gated; safe fields only).
  let authorityBlock = { visible: false };
  if (await isModuleEnabled('corporateAuthority')) {
    const activeAuthority = await all(`SELECT id, status, authorityBasis, authorityDate, expiryDate
      FROM client_authority_records WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC`, [clientId]);
    const latestAuthority = activeAuthority.length ? activeAuthority[0] : null;
    authorityBlock = {
      visible: true,
      activeCount: activeAuthority.length,
      latest: latestAuthority ? {
        id: latestAuthority.id,
        status: latestAuthority.status || 'pending',
        authorityBasis: latestAuthority.authorityBasis || '',
        authorityDate: latestAuthority.authorityDate || '',
        expiryDate: latestAuthority.expiryDate || '',
      } : null,
    };
  }

  // RET-31I: retainer lifecycle event snapshot summary (double module-gated; safe fields only).
  let lifecycleBlock = { visible: false };
  if ((await isModuleEnabled('retainerManagement')) && (await isModuleEnabled('scopeVariation'))) {
    const activeEvents = await all(`SELECT id, eventType, status, effectiveDate, noticeDate, title, matterId
      FROM retainer_lifecycle_events WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC`, [clientId]);
    const latestEvent = activeEvents.length ? activeEvents[0] : null;
    const eventCounts = { scope_variation: 0, suspension: 0, resumption: 0, termination: 0, closure: 0, pending: 0 };
    for (const e of activeEvents) {
      if (eventCounts[e.eventType] !== undefined) eventCounts[e.eventType]++;
      if (e.status === 'pending') eventCounts.pending++;
    }
    lifecycleBlock = {
      visible: true,
      activeCount: activeEvents.length,
      latest: latestEvent ? {
        id: latestEvent.id,
        eventType: latestEvent.eventType || '',
        status: latestEvent.status || 'recorded',
        effectiveDate: latestEvent.effectiveDate || '',
        noticeDate: latestEvent.noticeDate || '',
        title: latestEvent.title || '',
        matterId: latestEvent.matterId || '',
      } : null,
      summary: eventCounts,
    };
  }

  res.json({
    client: {
      id: clientRow.id,
      name: clientRow.name || '',
      type: clientRow.type || '',
      status: clientRow.status || '',
      joinDate: clientRow.joinDate || '',
      contact: clientRow.contact || '',
      email: clientRow.email || '',
      phone: clientRow.phone || '',
      conflictCleared,
    },
    matters: { activeCount, totalCount, nextAppearance },
    obligations: { openDeadlinesCount, nextDeadline, pendingDocumentRequestsCount },
    billing,
    recentDocuments,
    attentionFlags,
    retainer: retainerBlock,
    feePlan: feePlanBlock,
    ledger: ledgerBlock,
    kyc: kycBlock,
    authority: authorityBlock,
    lifecycle: lifecycleBlock,
  });
});
// RET-31D: retainer intake and scope schedule routes (module-gated, staff-only).
async function canAccessRetainer(req, clientId, matterId) {
  if (req.user.role === 'admin' || req.user.role === 'assistant') return true;
  if (req.user.role === 'advocate') {
    if (!(await canAccessClient(req, clientId))) return false;
    if (matterId && !(await canAccessMatter(req, matterId))) return false;
    return true;
  }
  return false;
}

app.get('/api/retainers', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const { clientId, matterId, status, includeInactive } = req.query;
  const conditions = [];
  const params = [];
  if (clientId) { conditions.push('r.clientId=?'); params.push(clientId); }
  if (matterId) { conditions.push('r.matterId=?'); params.push(matterId); }
  if (status) { conditions.push('r.status=?'); params.push(status); }
  if (includeInactive !== 'true') { conditions.push('r.isActive=1'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_records r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId
    ${where} ORDER BY r.createdAt DESC`, params);
  const scoped = [];
  for (const row of rows) {
    if (await canAccessRetainer(req, row.clientId, row.matterId)) {
      scoped.push(publicRetainerRecord(row));
    }
  }
  res.json(scoped);
});

app.get('/api/retainers/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const row = await get(`SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_records r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId
    WHERE r.id=?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Retainer record not found' });
  if (!await canAccessRetainer(req, row.clientId, row.matterId)) {
    return res.status(403).json({ error: 'Retainer access denied' });
  }
  res.json(publicRetainerRecord(row));
});

app.post('/api/retainers', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const { clientId, matterId, status, engagementType, engagementStartDate, signedDate, responsibleAdvocate,
    scopeSummary, exclusionsSummary, clientObligationsSummary, firmObligationsSummary,
    billingArrangementSummary, terminationTermsSummary, notes } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  if (status && !ALLOWED_RETAINER_STATUSES.has(status)) return res.status(400).json({ error: `Invalid status. Allowed: ${[...ALLOWED_RETAINER_STATUSES].join(', ')}` });
  if (engagementType && !ALLOWED_RETAINER_ENGAGEMENT_TYPES.has(engagementType)) return res.status(400).json({ error: `Invalid engagementType. Allowed: ${[...ALLOWED_RETAINER_ENGAGEMENT_TYPES].join(', ')}` });
  if (engagementStartDate) {
    const d = new Date(engagementStartDate);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid engagementStartDate' });
  }
  if (signedDate) {
    const d = new Date(signedDate);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid signedDate' });
  }
  const maxLen = 5000;
  if ((scopeSummary || '').length > maxLen) return res.status(400).json({ error: 'scopeSummary exceeds 5000 characters' });
  if ((exclusionsSummary || '').length > maxLen) return res.status(400).json({ error: 'exclusionsSummary exceeds 5000 characters' });
  if ((clientObligationsSummary || '').length > maxLen) return res.status(400).json({ error: 'clientObligationsSummary exceeds 5000 characters' });
  if ((firmObligationsSummary || '').length > maxLen) return res.status(400).json({ error: 'firmObligationsSummary exceeds 5000 characters' });
  if ((billingArrangementSummary || '').length > maxLen) return res.status(400).json({ error: 'billingArrangementSummary exceeds 5000 characters' });
  if ((terminationTermsSummary || '').length > maxLen) return res.status(400).json({ error: 'terminationTermsSummary exceeds 5000 characters' });
  if ((notes || '').length > 10000) return res.status(400).json({ error: 'notes exceeds 10000 characters' });
  const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
  if (!client) return res.status(400).json({ error: 'Client not found' });
  if (matterId) {
    const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(400).json({ error: 'Matter not found' });
    if (matter.clientId !== clientId) return res.status(400).json({ error: 'matterId does not belong to clientId' });
  }
  if (!await canAccessRetainer(req, clientId, matterId)) {
    return res.status(403).json({ error: 'Retainer create denied' });
  }
  const id = genId('RET');
  const now = new Date().toISOString();
  await run(`INSERT INTO retainer_records (id,clientId,matterId,status,engagementType,engagementStartDate,signedDate,responsibleAdvocate,scopeSummary,exclusionsSummary,clientObligationsSummary,firmObligationsSummary,billingArrangementSummary,terminationTermsSummary,notes,isActive,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [id, clientId, matterId || null, status || 'not_started', engagementType || null, engagementStartDate || null, signedDate || null, responsibleAdvocate || null,
     scopeSummary || '', exclusionsSummary || '', clientObligationsSummary || '', firmObligationsSummary || '',
     billingArrangementSummary || '', terminationTermsSummary || '', notes || '', req.user.userId || '', now]);
  await recordAuditEvent(req, {
    action: 'retainer_record_created',
    entityType: 'retainer_record',
    entityId: id,
    clientId,
    matterId: matterId || '',
    metadata: { retainerId: id, clientId, matterId: matterId || '', status: status || 'not_started', engagementType: engagementType || '', engagementStartDate: engagementStartDate || '', signedDate: signedDate || '', isActive: 1 },
  }).catch(() => {});
  const row = await get(`SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_records r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId WHERE r.id=?`, [id]);
  res.status(201).json(publicRetainerRecord(row));
});

app.patch('/api/retainers/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const existing = await get(`SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_records r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Retainer record not found' });
  if (!await canAccessRetainer(req, existing.clientId, existing.matterId)) {
    return res.status(403).json({ error: 'Retainer update denied' });
  }
  if (req.body.clientId !== undefined && req.body.clientId !== existing.clientId) {
    return res.status(400).json({ error: 'clientId cannot be changed after creation' });
  }
  const { status, engagementType, engagementStartDate, signedDate, responsibleAdvocate, matterId,
    scopeSummary, exclusionsSummary, clientObligationsSummary, firmObligationsSummary,
    billingArrangementSummary, terminationTermsSummary, notes } = req.body;
  if (status !== undefined && !ALLOWED_RETAINER_STATUSES.has(status)) return res.status(400).json({ error: `Invalid status. Allowed: ${[...ALLOWED_RETAINER_STATUSES].join(', ')}` });
  if (engagementType !== undefined && !ALLOWED_RETAINER_ENGAGEMENT_TYPES.has(engagementType)) return res.status(400).json({ error: `Invalid engagementType. Allowed: ${[...ALLOWED_RETAINER_ENGAGEMENT_TYPES].join(', ')}` });
  if (engagementStartDate !== undefined) {
    const d = new Date(engagementStartDate);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid engagementStartDate' });
  }
  if (signedDate !== undefined) {
    const d = new Date(signedDate);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid signedDate' });
  }
  const maxLen = 5000;
  if ((scopeSummary || '').length > maxLen) return res.status(400).json({ error: 'scopeSummary exceeds 5000 characters' });
  if ((exclusionsSummary || '').length > maxLen) return res.status(400).json({ error: 'exclusionsSummary exceeds 5000 characters' });
  if ((clientObligationsSummary || '').length > maxLen) return res.status(400).json({ error: 'clientObligationsSummary exceeds 5000 characters' });
  if ((firmObligationsSummary || '').length > maxLen) return res.status(400).json({ error: 'firmObligationsSummary exceeds 5000 characters' });
  if ((billingArrangementSummary || '').length > maxLen) return res.status(400).json({ error: 'billingArrangementSummary exceeds 5000 characters' });
  if ((terminationTermsSummary || '').length > maxLen) return res.status(400).json({ error: 'terminationTermsSummary exceeds 5000 characters' });
  if ((notes || '').length > 10000) return res.status(400).json({ error: 'notes exceeds 10000 characters' });
  if (matterId !== undefined) {
    if (matterId === '' || matterId === null) {
      return res.status(400).json({ error: 'matterId cannot be cleared in v1' });
    }
    const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(400).json({ error: 'Matter not found' });
    if (matter.clientId !== existing.clientId) return res.status(400).json({ error: 'matterId does not belong to this client' });
  }
  const fields = [];
  const vals = [];
  if (status !== undefined) { fields.push('status=?'); vals.push(status); }
  if (engagementType !== undefined) { fields.push('engagementType=?'); vals.push(engagementType); }
  if (engagementStartDate !== undefined) { fields.push('engagementStartDate=?'); vals.push(engagementStartDate); }
  if (signedDate !== undefined) { fields.push('signedDate=?'); vals.push(signedDate); }
  if (responsibleAdvocate !== undefined) { fields.push('responsibleAdvocate=?'); vals.push(responsibleAdvocate); }
  if (matterId !== undefined) { fields.push('matterId=?'); vals.push(matterId); }
  if (scopeSummary !== undefined) { fields.push('scopeSummary=?'); vals.push(scopeSummary); }
  if (exclusionsSummary !== undefined) { fields.push('exclusionsSummary=?'); vals.push(exclusionsSummary); }
  if (clientObligationsSummary !== undefined) { fields.push('clientObligationsSummary=?'); vals.push(clientObligationsSummary); }
  if (firmObligationsSummary !== undefined) { fields.push('firmObligationsSummary=?'); vals.push(firmObligationsSummary); }
  if (billingArrangementSummary !== undefined) { fields.push('billingArrangementSummary=?'); vals.push(billingArrangementSummary); }
  if (terminationTermsSummary !== undefined) { fields.push('terminationTermsSummary=?'); vals.push(terminationTermsSummary); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  const now = new Date().toISOString();
  fields.push('updatedAt=?'); vals.push(now);
  fields.push('updatedBy=?'); vals.push(req.user.userId || '');
  vals.push(req.params.id);
  await run(`UPDATE retainer_records SET ${fields.join(', ')} WHERE id=?`, vals);
  const newStatus = status !== undefined ? status : existing.status;
  const newEngagementType = engagementType !== undefined ? engagementType : (existing.engagementType || '');
  const newEngagementStartDate = engagementStartDate !== undefined ? engagementStartDate : (existing.engagementStartDate || '');
  const newSignedDate = signedDate !== undefined ? signedDate : (existing.signedDate || '');
  await recordAuditEvent(req, {
    action: 'retainer_record_updated',
    entityType: 'retainer_record',
    entityId: req.params.id,
    clientId: existing.clientId,
    matterId: existing.matterId || '',
    metadata: { retainerId: req.params.id, clientId: existing.clientId, matterId: existing.matterId || '', status: newStatus, engagementType: newEngagementType, engagementStartDate: newEngagementStartDate, signedDate: newSignedDate, isActive: Number(existing.isActive) },
  }).catch(() => {});
  const updated = await get(`SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_records r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId WHERE r.id=?`, [req.params.id]);
  res.json(publicRetainerRecord(updated));
});

app.delete('/api/retainers/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const existing = await get(`SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_records r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Retainer record not found' });
  if (!await canAccessRetainer(req, existing.clientId, existing.matterId)) {
    return res.status(403).json({ error: 'Retainer deactivate denied' });
  }
  const now = new Date().toISOString();
  await run('UPDATE retainer_records SET isActive=0, deactivatedBy=?, deactivatedAt=?, updatedAt=? WHERE id=?', [req.user.userId || '', now, now, req.params.id]);
  await recordAuditEvent(req, {
    action: 'retainer_record_deactivated',
    entityType: 'retainer_record',
    entityId: req.params.id,
    clientId: existing.clientId,
    matterId: existing.matterId || '',
    metadata: { retainerId: req.params.id, clientId: existing.clientId, matterId: existing.matterId || '', status: existing.status, engagementType: existing.engagementType || '', engagementStartDate: existing.engagementStartDate || '', signedDate: existing.signedDate || '', isActive: 0 },
  }).catch(() => {});
  res.json({ message: 'Retainer record deactivated' });
});

// RET-31J: retainer document generator (module-gated retainerManagement, staff-only).
// Reuses the existing document template merge + matter-document storage pipeline.
// No new schema, no PDF/DOCX/signing; output is text/plain saved as a matter document
// (staff-only by default). Optional KYC/authority/lifecycle merge fields resolve blank
// when their modules are disabled — generation is never blocked by those optional modules.
function retainerDocumentText(value) {
  // Stringify safely; never return null so dotted tokens always resolve (no unresolved spam).
  if (value === undefined || value === null) return '';
  return String(value);
}

async function buildRetainerMergeNamespaces(retainerRow, matterRow) {
  const clientId = retainerRow.clientId;
  const matterId = matterRow ? matterRow.id : (retainerRow.matterId || '');

  // retainer namespace — document-body fields only; never `notes`.
  const retainer = {
    id: retainerDocumentText(retainerRow.id),
    status: retainerDocumentText(retainerRow.status),
    engagementType: retainerDocumentText(retainerRow.engagementType),
    engagementStartDate: retainerDocumentText(retainerRow.engagementStartDate),
    signedDate: retainerDocumentText(retainerRow.signedDate),
    responsibleAdvocate: retainerDocumentText(retainerRow.responsibleAdvocate),
    scopeSummary: retainerDocumentText(retainerRow.scopeSummary),
    exclusionsSummary: retainerDocumentText(retainerRow.exclusionsSummary),
    clientObligationsSummary: retainerDocumentText(retainerRow.clientObligationsSummary),
    firmObligationsSummary: retainerDocumentText(retainerRow.firmObligationsSummary),
    billingArrangementSummary: retainerDocumentText(retainerRow.billingArrangementSummary),
    terminationTermsSummary: retainerDocumentText(retainerRow.terminationTermsSummary),
  };

  // feePlan namespace — latest active fee plan, preferring the resolved matter, else client.
  // Record/planning fields only; never compute invoice/payment/VAT values.
  let feePlanRow = null;
  if (matterId) {
    feePlanRow = await get('SELECT * FROM matter_fee_plans WHERE clientId=? AND matterId=? AND isActive=1 ORDER BY createdAt DESC LIMIT 1', [clientId, matterId]);
  }
  if (!feePlanRow) {
    feePlanRow = await get('SELECT * FROM matter_fee_plans WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC LIMIT 1', [clientId]);
  }
  const feePlan = {
    id: retainerDocumentText(feePlanRow?.id),
    feeType: retainerDocumentText(feePlanRow?.feeType),
    status: retainerDocumentText(feePlanRow?.status),
    currency: retainerDocumentText(feePlanRow?.currency),
    estimatedAmount: feePlanRow && feePlanRow.estimatedAmount !== null && feePlanRow.estimatedAmount !== undefined ? retainerDocumentText(feePlanRow.estimatedAmount) : '',
    hourlyRate: feePlanRow && feePlanRow.hourlyRate !== null && feePlanRow.hourlyRate !== undefined ? retainerDocumentText(feePlanRow.hourlyRate) : '',
    capAmount: feePlanRow && feePlanRow.capAmount !== null && feePlanRow.capAmount !== undefined ? retainerDocumentText(feePlanRow.capAmount) : '',
    depositRequired: feePlanRow && feePlanRow.depositRequired !== null && feePlanRow.depositRequired !== undefined ? retainerDocumentText(feePlanRow.depositRequired) : '',
    billingFrequency: retainerDocumentText(feePlanRow?.billingFrequency),
    vatTreatment: retainerDocumentText(feePlanRow?.vatTreatment),
  };

  // kyc namespace — safe summary ONLY, and ONLY when the kycCdd module is enabled.
  const kyc = { status: '', clientCategory: '', riskLevel: '', verificationDate: '', expiryDate: '' };
  if (await isModuleEnabled('kycCdd')) {
    const kycRow = await get('SELECT status, clientCategory, riskLevel, verificationDate, expiryDate FROM client_kyc_records WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC LIMIT 1', [clientId]);
    if (kycRow) {
      kyc.status = retainerDocumentText(kycRow.status);
      kyc.clientCategory = retainerDocumentText(kycRow.clientCategory);
      kyc.riskLevel = retainerDocumentText(kycRow.riskLevel);
      kyc.verificationDate = retainerDocumentText(kycRow.verificationDate);
      kyc.expiryDate = retainerDocumentText(kycRow.expiryDate);
    }
  }

  // authority namespace — safe summary ONLY, and ONLY when corporateAuthority is enabled.
  const authority = { status: '', authorityBasis: '', authorityDate: '', expiryDate: '', authorisedPersonName: '', authorisedPersonRole: '' };
  if (await isModuleEnabled('corporateAuthority')) {
    const authRow = await get('SELECT status, authorityBasis, authorityDate, expiryDate, authorisedPersonName, authorisedPersonRole FROM client_authority_records WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC LIMIT 1', [clientId]);
    if (authRow) {
      authority.status = retainerDocumentText(authRow.status);
      authority.authorityBasis = retainerDocumentText(authRow.authorityBasis);
      authority.authorityDate = retainerDocumentText(authRow.authorityDate);
      authority.expiryDate = retainerDocumentText(authRow.expiryDate);
      authority.authorisedPersonName = retainerDocumentText(authRow.authorisedPersonName);
      authority.authorisedPersonRole = retainerDocumentText(authRow.authorisedPersonRole);
    }
  }

  // lifecycle namespace — safe summary ONLY, and ONLY when retainerManagement + scopeVariation are enabled.
  const lifecycle = { eventType: '', status: '', effectiveDate: '', noticeDate: '', title: '' };
  if ((await isModuleEnabled('retainerManagement')) && (await isModuleEnabled('scopeVariation'))) {
    const lceRow = await get('SELECT eventType, status, effectiveDate, noticeDate, title FROM retainer_lifecycle_events WHERE clientId=? AND isActive=1 ORDER BY createdAt DESC LIMIT 1', [clientId]);
    if (lceRow) {
      lifecycle.eventType = retainerDocumentText(lceRow.eventType);
      lifecycle.status = retainerDocumentText(lceRow.status);
      lifecycle.effectiveDate = retainerDocumentText(lceRow.effectiveDate);
      lifecycle.noticeDate = retainerDocumentText(lceRow.noticeDate);
      lifecycle.title = retainerDocumentText(lceRow.title);
    }
  }

  return { retainer, feePlan, kyc, authority, lifecycle };
}

app.post('/api/retainers/:id/generate-document', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;

  // 1. Load retainer (404 missing, 400 inactive).
  const retainer = await get(`SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_records r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId WHERE r.id=?`, [req.params.id]);
  if (!retainer) return res.status(404).json({ error: 'Retainer record not found' });
  if (Number(retainer.isActive) !== 1) return res.status(400).json({ error: 'Retainer record is not active' });

  // 2. Access enforcement (admin/assistant all; advocate client+matter; client forbidden).
  if (!await canAccessRetainer(req, retainer.clientId, retainer.matterId)) {
    await recordAuditEvent(req, {
      action: 'forbidden_retainer_document_generation',
      entityType: 'retainer_record',
      entityId: req.params.id,
      clientId: retainer.clientId,
      matterId: retainer.matterId || '',
      metadata: { reason: 'insufficient permissions', route: 'retainer_document_generate', retainerId: req.params.id },
    }).catch(() => {});
    return res.status(403).json({ error: 'Retainer document generation access denied' });
  }

  const { templateId, matterId: bodyMatterId, filename, clientVisible } = req.body || {};

  // 3. Resolve matterId (documents.matterId is NOT NULL).
  const resolvedMatterId = retainer.matterId || (typeof bodyMatterId === 'string' ? bodyMatterId.trim() : '') || '';
  if (!resolvedMatterId) {
    return res.status(400).json({ error: 'matterId is required when the retainer has no linked matter' });
  }

  // 4. Validate matter (exists, belongs to retainer client, advocate can access it).
  const matter = await get('SELECT * FROM matters WHERE id=?', [resolvedMatterId]);
  if (!matter) return res.status(400).json({ error: 'Matter not found' });
  if (matter.clientId !== retainer.clientId) {
    return res.status(400).json({ error: 'matterId does not belong to the retainer client' });
  }
  if (!await canAccessMatter(req, resolvedMatterId)) {
    await recordAuditEvent(req, {
      action: 'forbidden_retainer_document_generation',
      entityType: 'retainer_record',
      entityId: req.params.id,
      clientId: retainer.clientId,
      matterId: resolvedMatterId,
      metadata: { reason: 'matter access denied', route: 'retainer_document_generate', retainerId: req.params.id },
    }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }

  // 5. Load active document template (templateId required; missing/inactive -> 404).
  if (!templateId || typeof templateId !== 'string') {
    return res.status(400).json({ error: 'templateId is required' });
  }
  const template = await get('SELECT * FROM document_templates WHERE id=? AND active=1', [templateId]);
  if (!template) return res.status(404).json({ error: 'Active document template not found' });

  // 6. Compose merge context on top of the existing helper (helper left unmodified).
  const [client, firm] = await Promise.all([
    get('SELECT * FROM clients WHERE id=?', [retainer.clientId]),
    get('SELECT * FROM firm_settings WHERE id=?', ['default']),
  ]);
  const baseContext = buildTemplateMergeContext({
    firm: firm || {},
    matter,
    client: client || {},
    user: req.user || {},
    today: today(),
  });
  const namespaces = await buildRetainerMergeNamespaces(retainer, matter);
  const context = { ...baseContext, ...namespaces };

  // 7. Merge.
  const merged = mergeTemplateMarkup(template.bodyMarkup || '', context);

  // 8. Save as a matter document using the existing generated-document pattern.
  const content = Buffer.from(merged.preview, 'utf8');
  const documentId = genId('DOC');
  const generatedAt = new Date().toISOString();
  const generatedDate = today();
  const requestedName = typeof filename === 'string' && filename.trim() ? filename.trim() : `${template.name || 'Retainer document'} ${generatedDate}`;
  let displayName = cleanDocumentName(requestedName);
  if (!/\.txt$/i.test(displayName)) displayName = cleanDocumentName(`${displayName}.txt`);
  const name = displayName;
  const actor = actorLabel(req);
  const size = `${Math.max(1, Math.round(content.length / 1024))} KB`;

  // clientVisible honored only for share-capable roles (admin/advocate), matching the
  // existing requireAdvocateOrAdmin document-visibility control; default staff-only (0).
  const wantsVisible = clientVisible === true || clientVisible === 1 || clientVisible === '1' || clientVisible === 'true';
  const canShareWithClient = req.user.role === 'admin' || req.user.role === 'advocate';
  const finalClientVisible = (wantsVisible && canShareWithClient) ? 1 : 0;

  await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy,templateId,templateName,generatedBy,generatedAt,version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    documentId,
    resolvedMatterId,
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
    finalClientVisible,
    actor,
    template.id,
    template.name || '',
    actor,
    generatedAt,
    1,
  ]);

  const doc = await get(`SELECT d.id,d.matterId,d.name,d.displayName,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,d.messageId,d.noticeId,d.clientVisible,d.uploadedBy,d.templateId,d.templateName,d.generatedBy,d.generatedAt,d.version,f.name folderName
    FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.id=?`, [documentId]);

  // 10. Audit — whitelist metadata only; never content/free text/PII.
  await logAudit(req, 'generate', 'document', documentId, `Generated retainer document ${doc.displayName || doc.name}`);
  await recordAuditEvent(req, {
    action: 'retainer_document_generated',
    entityType: 'document',
    entityId: documentId,
    matterId: resolvedMatterId,
    clientId: retainer.clientId,
    metadata: {
      retainerId: retainer.id,
      clientId: retainer.clientId,
      matterId: resolvedMatterId,
      templateId: template.id,
      templateName: template.name || '',
      documentId,
      filename: cleanDocumentName(doc.displayName || doc.name || documentId),
      clientVisible: finalClientVisible,
      unresolvedTokenCount: merged.unresolvedTokens.length,
      contentLength: content.length,
      source: 'retainer_document_generator',
    },
  }).catch(() => {});

  // 9. Respond with public metadata only (content never returned).
  res.status(201).json({
    document: publicDocument(doc),
    unresolvedTokens: merged.unresolvedTokens,
  });
});

// RET-31E: matter fee plan routes (module-gated, staff-only; planning/record only).
const FEE_PLAN_SELECT = `SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM matter_fee_plans r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId`;

async function canAccessFeePlan(req, clientId, matterId) {
  if (req.user.role === 'admin' || req.user.role === 'assistant') return true;
  if (req.user.role === 'advocate') {
    if (!(await canAccessClient(req, clientId))) return false;
    if (!(await canAccessMatter(req, matterId))) return false;
    return true;
  }
  return false;
}

// RET-31E: whitelist audit metadata (excludes notes/paymentTerms/disbursementsTreatment).
function feePlanAuditMetadata(row, isActiveOverride) {
  return {
    feePlanId: row.id,
    clientId: row.clientId,
    matterId: row.matterId,
    retainerId: row.retainerId || '',
    feeType: row.feeType || '',
    status: row.status || '',
    currency: row.currency || '',
    estimatedAmount: feePlanNumOrNull(row.estimatedAmount),
    hourlyRate: feePlanNumOrNull(row.hourlyRate),
    capAmount: feePlanNumOrNull(row.capAmount),
    depositRequired: feePlanNumOrNull(row.depositRequired),
    billingFrequency: row.billingFrequency || '',
    vatTreatment: row.vatTreatment || '',
    isActive: isActiveOverride !== undefined ? isActiveOverride : Number(row.isActive),
  };
}

app.get('/api/matter-fee-plans', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const { clientId, matterId, retainerId, status, includeInactive } = req.query;
  const conditions = [];
  const params = [];
  if (clientId) { conditions.push('r.clientId=?'); params.push(clientId); }
  if (matterId) { conditions.push('r.matterId=?'); params.push(matterId); }
  if (retainerId) { conditions.push('r.retainerId=?'); params.push(retainerId); }
  if (status) { conditions.push('r.status=?'); params.push(status); }
  if (includeInactive !== 'true') { conditions.push('r.isActive=1'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`${FEE_PLAN_SELECT} ${where} ORDER BY r.createdAt DESC`, params);
  const scoped = [];
  for (const row of rows) {
    if (await canAccessFeePlan(req, row.clientId, row.matterId)) {
      scoped.push(publicFeePlan(row));
    }
  }
  res.json(scoped);
});

app.get('/api/matter-fee-plans/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const row = await get(`${FEE_PLAN_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Fee plan not found' });
  if (!await canAccessFeePlan(req, row.clientId, row.matterId)) {
    return res.status(403).json({ error: 'Fee plan access denied' });
  }
  res.json(publicFeePlan(row));
});

app.post('/api/matter-fee-plans', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const { clientId, matterId, retainerId, feeType, currency, estimatedAmount, hourlyRate, capAmount, depositRequired,
    billingFrequency, paymentTerms, vatTreatment, disbursementsTreatment, status, notes } = req.body;
  const validationError = validateFeePlanPayload(req.body, { partial: false });
  if (validationError) return res.status(400).json({ error: validationError });
  const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
  if (!client) return res.status(400).json({ error: 'Client not found' });
  const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [matterId]);
  if (!matter) return res.status(400).json({ error: 'Matter not found' });
  if (matter.clientId !== clientId) return res.status(400).json({ error: 'matterId does not belong to clientId' });
  if (retainerId) {
    const ret = await get('SELECT id, clientId, matterId, isActive FROM retainer_records WHERE id=?', [retainerId]);
    if (!ret) return res.status(400).json({ error: 'Retainer not found' });
    if (Number(ret.isActive) !== 1) return res.status(400).json({ error: 'retainerId is not active' });
    if (ret.clientId !== clientId) return res.status(400).json({ error: 'retainerId does not belong to this client' });
    if ((ret.matterId || '') !== matterId) return res.status(400).json({ error: 'retainerId does not belong to this matter' });
  }
  if (!await canAccessFeePlan(req, clientId, matterId)) {
    return res.status(403).json({ error: 'Fee plan create denied' });
  }
  const id = genId('FEE');
  const now = new Date().toISOString();
  await run(`INSERT INTO matter_fee_plans (id,clientId,matterId,retainerId,feeType,currency,estimatedAmount,hourlyRate,capAmount,depositRequired,billingFrequency,paymentTerms,vatTreatment,disbursementsTreatment,status,notes,isActive,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [id, clientId, matterId, retainerId || null, feeType, (currency || 'KES'),
     feePlanNumOrNull(estimatedAmount), feePlanNumOrNull(hourlyRate), feePlanNumOrNull(capAmount), feePlanNumOrNull(depositRequired),
     billingFrequency || null, paymentTerms || '', vatTreatment || null, disbursementsTreatment || null, status || 'draft', notes || '', req.user.userId || '', now]);
  const row = await get(`${FEE_PLAN_SELECT} WHERE r.id=?`, [id]);
  await recordAuditEvent(req, {
    action: 'matter_fee_plan_created',
    entityType: 'matter_fee_plan',
    entityId: id,
    clientId,
    matterId,
    metadata: feePlanAuditMetadata(row, 1),
  }).catch(() => {});
  res.status(201).json(publicFeePlan(row));
});

app.patch('/api/matter-fee-plans/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const existing = await get(`${FEE_PLAN_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Fee plan not found' });
  if (!await canAccessFeePlan(req, existing.clientId, existing.matterId)) {
    return res.status(403).json({ error: 'Fee plan update denied' });
  }
  if (req.body.clientId !== undefined && req.body.clientId !== existing.clientId) {
    return res.status(400).json({ error: 'clientId cannot be changed after creation' });
  }
  if (req.body.matterId !== undefined && req.body.matterId !== existing.matterId) {
    return res.status(400).json({ error: 'matterId cannot be changed after creation' });
  }
  const validationError = validateFeePlanPayload(req.body, { partial: true });
  if (validationError) return res.status(400).json({ error: validationError });
  const { retainerId, feeType, currency, estimatedAmount, hourlyRate, capAmount, depositRequired,
    billingFrequency, paymentTerms, vatTreatment, disbursementsTreatment, status, notes } = req.body;
  if (retainerId !== undefined && retainerId !== null && retainerId !== '') {
    const ret = await get('SELECT id, clientId, matterId, isActive FROM retainer_records WHERE id=?', [retainerId]);
    if (!ret) return res.status(400).json({ error: 'Retainer not found' });
    if (Number(ret.isActive) !== 1) return res.status(400).json({ error: 'retainerId is not active' });
    if (ret.clientId !== existing.clientId) return res.status(400).json({ error: 'retainerId does not belong to this client' });
    if ((ret.matterId || '') !== existing.matterId) return res.status(400).json({ error: 'retainerId does not belong to this matter' });
  }
  const fields = [];
  const vals = [];
  if (retainerId !== undefined) { fields.push('retainerId=?'); vals.push(retainerId || null); }
  if (feeType !== undefined) { fields.push('feeType=?'); vals.push(feeType); }
  if (currency !== undefined) { fields.push('currency=?'); vals.push(currency || 'KES'); }
  if (estimatedAmount !== undefined) { fields.push('estimatedAmount=?'); vals.push(feePlanNumOrNull(estimatedAmount)); }
  if (hourlyRate !== undefined) { fields.push('hourlyRate=?'); vals.push(feePlanNumOrNull(hourlyRate)); }
  if (capAmount !== undefined) { fields.push('capAmount=?'); vals.push(feePlanNumOrNull(capAmount)); }
  if (depositRequired !== undefined) { fields.push('depositRequired=?'); vals.push(feePlanNumOrNull(depositRequired)); }
  if (billingFrequency !== undefined) { fields.push('billingFrequency=?'); vals.push(billingFrequency || null); }
  if (paymentTerms !== undefined) { fields.push('paymentTerms=?'); vals.push(paymentTerms || ''); }
  if (vatTreatment !== undefined) { fields.push('vatTreatment=?'); vals.push(vatTreatment || null); }
  if (disbursementsTreatment !== undefined) { fields.push('disbursementsTreatment=?'); vals.push(disbursementsTreatment || null); }
  if (status !== undefined) { fields.push('status=?'); vals.push(status); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes || ''); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  const now = new Date().toISOString();
  fields.push('updatedAt=?'); vals.push(now);
  fields.push('updatedBy=?'); vals.push(req.user.userId || '');
  vals.push(req.params.id);
  await run(`UPDATE matter_fee_plans SET ${fields.join(', ')} WHERE id=?`, vals);
  const updated = await get(`${FEE_PLAN_SELECT} WHERE r.id=?`, [req.params.id]);
  await recordAuditEvent(req, {
    action: 'matter_fee_plan_updated',
    entityType: 'matter_fee_plan',
    entityId: req.params.id,
    clientId: existing.clientId,
    matterId: existing.matterId,
    metadata: feePlanAuditMetadata(updated),
  }).catch(() => {});
  res.json(publicFeePlan(updated));
});

app.delete('/api/matter-fee-plans/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  const existing = await get(`${FEE_PLAN_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Fee plan not found' });
  if (!await canAccessFeePlan(req, existing.clientId, existing.matterId)) {
    return res.status(403).json({ error: 'Fee plan deactivate denied' });
  }
  const now = new Date().toISOString();
  await run('UPDATE matter_fee_plans SET isActive=0, deactivatedBy=?, deactivatedAt=?, updatedAt=? WHERE id=?', [req.user.userId || '', now, now, req.params.id]);
  await recordAuditEvent(req, {
    action: 'matter_fee_plan_deactivated',
    entityType: 'matter_fee_plan',
    entityId: req.params.id,
    clientId: existing.clientId,
    matterId: existing.matterId,
    metadata: feePlanAuditMetadata(existing, 0),
  }).catch(() => {});
  res.json({ message: 'Fee plan deactivated' });
});

// RET-31F: retainer ledger routes (double module-gated, staff-only, append-only).
const LEDGER_SELECT = `SELECT r.*, c.name clientName, m.title matterTitle, m.reference matterReference
    FROM retainer_ledger_entries r LEFT JOIN clients c ON c.id=r.clientId LEFT JOIN matters m ON m.id=r.matterId`;

async function canAccessLedger(req, clientId, matterId) {
  if (req.user.role === 'admin' || req.user.role === 'assistant') return true;
  if (req.user.role === 'advocate') {
    if (!(await canAccessClient(req, clientId))) return false;
    if (matterId && !(await canAccessMatter(req, matterId))) return false;
    return true;
  }
  return false;
}

// Both module gates must pass; returns true only when both are enabled (else 403 already sent).
async function requireLedgerModules(req, res) {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return false;
  if (!await requireEnabledModule(req, res, 'retainerLedger', 'Retainer Ledger')) return false;
  return true;
}

app.get('/api/retainer-ledger', requireStaff, async (req, res) => {
  if (!await requireLedgerModules(req, res)) return;
  const { clientId, matterId, retainerId, feePlanId, includeVoided } = req.query;
  const conditions = [];
  const params = [];
  if (clientId) { conditions.push('r.clientId=?'); params.push(clientId); }
  if (matterId) { conditions.push('r.matterId=?'); params.push(matterId); }
  if (retainerId) { conditions.push('r.retainerId=?'); params.push(retainerId); }
  if (feePlanId) { conditions.push('r.feePlanId=?'); params.push(feePlanId); }
  if (includeVoided !== 'true') { conditions.push('r.isVoided=0'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`${LEDGER_SELECT} ${where} ORDER BY r.entryDate DESC, r.createdAt DESC`, params);
  const scoped = [];
  for (const row of rows) {
    if (await canAccessLedger(req, row.clientId, row.matterId)) {
      scoped.push(publicLedgerEntry(row));
    }
  }
  res.json(scoped);
});

app.get('/api/retainer-ledger/summary', requireStaff, async (req, res) => {
  if (!await requireLedgerModules(req, res)) return;
  const { clientId, matterId, retainerId, feePlanId } = req.query;
  const conditions = ['r.isVoided=0'];
  const params = [];
  if (clientId) { conditions.push('r.clientId=?'); params.push(clientId); }
  if (matterId) { conditions.push('r.matterId=?'); params.push(matterId); }
  if (retainerId) { conditions.push('r.retainerId=?'); params.push(retainerId); }
  if (feePlanId) { conditions.push('r.feePlanId=?'); params.push(feePlanId); }
  const where = 'WHERE ' + conditions.join(' AND ');
  const rows = await all(`${LEDGER_SELECT} ${where}`, params);
  const accessible = [];
  for (const row of rows) {
    if (await canAccessLedger(req, row.clientId, row.matterId)) accessible.push(row);
  }
  res.json(computeLedgerSummary(accessible));
});

app.post('/api/retainer-ledger', requireStaff, async (req, res) => {
  if (!await requireLedgerModules(req, res)) return;
  const { clientId, matterId, retainerId, feePlanId, entryType, direction, amount, currency,
    entryDate, reference, description, sourceType, sourceId } = req.body;
  const validationError = validateLedgerPayload(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
  if (!client) return res.status(400).json({ error: 'Client not found' });
  if (matterId) {
    const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(400).json({ error: 'Matter not found' });
    if (matter.clientId !== clientId) return res.status(400).json({ error: 'matterId does not belong to clientId' });
  }
  if (retainerId) {
    const ret = await get('SELECT id, clientId, matterId, isActive FROM retainer_records WHERE id=?', [retainerId]);
    if (!ret) return res.status(400).json({ error: 'Retainer not found' });
    if (Number(ret.isActive) !== 1) return res.status(400).json({ error: 'retainerId is not active' });
    if (ret.clientId !== clientId) return res.status(400).json({ error: 'retainerId does not belong to this client' });
    if (matterId && (ret.matterId || '') !== matterId) return res.status(400).json({ error: 'retainerId does not belong to this matter' });
  }
  if (feePlanId) {
    const fp = await get('SELECT id, clientId, matterId, isActive FROM matter_fee_plans WHERE id=?', [feePlanId]);
    if (!fp) return res.status(400).json({ error: 'Fee plan not found' });
    if (Number(fp.isActive) !== 1) return res.status(400).json({ error: 'feePlanId is not active' });
    if (fp.clientId !== clientId) return res.status(400).json({ error: 'feePlanId does not belong to this client' });
    if (matterId && (fp.matterId || '') !== matterId) return res.status(400).json({ error: 'feePlanId does not belong to this matter' });
  }
  if (!await canAccessLedger(req, clientId, matterId)) {
    return res.status(403).json({ error: 'Ledger create denied' });
  }
  const id = genId('LED');
  const now = new Date().toISOString();
  await run(`INSERT INTO retainer_ledger_entries (id,clientId,matterId,retainerId,feePlanId,entryType,direction,amount,currency,entryDate,reference,description,sourceType,sourceId,isVoided,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [id, clientId, matterId || null, retainerId || null, feePlanId || null, entryType, direction, Number(amount),
     (currency || 'KES'), entryDate, reference || null, description || null, sourceType || null, sourceId || null, req.user.userId || '', now]);
  const row = await get(`${LEDGER_SELECT} WHERE r.id=?`, [id]);
  await recordAuditEvent(req, {
    action: 'retainer_ledger_entry_created',
    entityType: 'retainer_ledger_entry',
    entityId: id,
    clientId,
    matterId: matterId || '',
    metadata: ledgerAuditMetadata(row, 0),
  }).catch(() => {});
  res.status(201).json(publicLedgerEntry(row));
});

app.post('/api/retainer-ledger/:id/void', requireStaff, async (req, res) => {
  if (!await requireLedgerModules(req, res)) return;
  const existing = await get(`${LEDGER_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Ledger entry not found' });
  if (!await canAccessLedger(req, existing.clientId, existing.matterId)) {
    return res.status(403).json({ error: 'Ledger void denied' });
  }
  if (Number(existing.isVoided) === 1) return res.status(409).json({ error: 'Ledger entry already voided' });
  const voidReason = (req.body && typeof req.body.voidReason === 'string') ? req.body.voidReason.slice(0, 1000) : '';
  const now = new Date().toISOString();
  await run('UPDATE retainer_ledger_entries SET isVoided=1, voidedBy=?, voidedAt=?, voidReason=?, updatedBy=?, updatedAt=? WHERE id=?',
    [req.user.userId || '', now, voidReason, req.user.userId || '', now, req.params.id]);
  const updated = await get(`${LEDGER_SELECT} WHERE r.id=?`, [req.params.id]);
  await recordAuditEvent(req, {
    action: 'retainer_ledger_entry_voided',
    entityType: 'retainer_ledger_entry',
    entityId: req.params.id,
    clientId: existing.clientId,
    matterId: existing.matterId || '',
    metadata: ledgerAuditMetadata(updated, 1),
  }).catch(() => {});
  res.json(publicLedgerEntry(updated));
});

// RET-31G: client KYC/CDD routes (module-gated, staff-only, metadata only).
const KYC_SELECT = `SELECT r.*, c.name clientName
    FROM client_kyc_records r LEFT JOIN clients c ON c.id=r.clientId`;

async function canAccessKyc(req, clientId) {
  if (req.user.role === 'admin' || req.user.role === 'assistant') return true;
  if (req.user.role === 'advocate') return canAccessClient(req, clientId);
  return false;
}

app.get('/api/client-kyc', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'kycCdd', 'KYC / CDD')) return;
  const { clientId, status, includeInactive } = req.query;
  const conditions = [];
  const params = [];
  if (clientId) { conditions.push('r.clientId=?'); params.push(clientId); }
  if (status) { conditions.push('r.status=?'); params.push(status); }
  if (includeInactive !== 'true') { conditions.push('r.isActive=1'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`${KYC_SELECT} ${where} ORDER BY r.createdAt DESC`, params);
  const scoped = [];
  for (const row of rows) {
    if (await canAccessKyc(req, row.clientId)) scoped.push(publicKycRecord(row));
  }
  res.json(scoped);
});

app.get('/api/client-kyc/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'kycCdd', 'KYC / CDD')) return;
  const row = await get(`${KYC_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'KYC record not found' });
  if (!await canAccessKyc(req, row.clientId)) return res.status(403).json({ error: 'KYC access denied' });
  res.json(publicKycRecord(row));
});

app.post('/api/client-kyc', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'kycCdd', 'KYC / CDD')) return;
  const { clientId, status, clientCategory, riskLevel, idNumber, kraPin, registrationNumber,
    verificationDate, expiryDate, sourceOfFundsSummary, pepStatus, sanctionsCheckStatus, verifiedBy, notes } = req.body;
  const validationError = validateKycPayload(req.body, { partial: false });
  if (validationError) return res.status(400).json({ error: validationError });
  const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
  if (!client) return res.status(400).json({ error: 'Client not found' });
  if (!await canAccessKyc(req, clientId)) return res.status(403).json({ error: 'KYC create denied' });
  const id = genId('KYC');
  const now = new Date().toISOString();
  await run(`INSERT INTO client_kyc_records (id,clientId,status,clientCategory,riskLevel,idNumber,kraPin,registrationNumber,verificationDate,expiryDate,sourceOfFundsSummary,pepStatus,sanctionsCheckStatus,verifiedBy,notes,isActive,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [id, clientId, status || 'not_started', clientCategory || null, riskLevel || null, idNumber || null, kraPin || null, registrationNumber || null,
     verificationDate || null, expiryDate || null, sourceOfFundsSummary || '', pepStatus || null, sanctionsCheckStatus || null, verifiedBy || null, notes || '', req.user.userId || '', now]);
  const row = await get(`${KYC_SELECT} WHERE r.id=?`, [id]);
  await recordAuditEvent(req, {
    action: 'client_kyc_record_created',
    entityType: 'client_kyc_record',
    entityId: id,
    clientId,
    metadata: kycAuditMetadata(row, 1),
  }).catch(() => {});
  res.status(201).json(publicKycRecord(row));
});

app.patch('/api/client-kyc/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'kycCdd', 'KYC / CDD')) return;
  const existing = await get(`${KYC_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'KYC record not found' });
  if (!await canAccessKyc(req, existing.clientId)) return res.status(403).json({ error: 'KYC update denied' });
  if (req.body.clientId !== undefined && req.body.clientId !== existing.clientId) {
    return res.status(400).json({ error: 'clientId cannot be changed after creation' });
  }
  const validationError = validateKycPayload(req.body, { partial: true });
  if (validationError) return res.status(400).json({ error: validationError });
  const { status, clientCategory, riskLevel, idNumber, kraPin, registrationNumber,
    verificationDate, expiryDate, sourceOfFundsSummary, pepStatus, sanctionsCheckStatus, verifiedBy, notes } = req.body;
  const fields = [];
  const vals = [];
  if (status !== undefined) { fields.push('status=?'); vals.push(status); }
  if (clientCategory !== undefined) { fields.push('clientCategory=?'); vals.push(clientCategory || null); }
  if (riskLevel !== undefined) { fields.push('riskLevel=?'); vals.push(riskLevel || null); }
  if (idNumber !== undefined) { fields.push('idNumber=?'); vals.push(idNumber || null); }
  if (kraPin !== undefined) { fields.push('kraPin=?'); vals.push(kraPin || null); }
  if (registrationNumber !== undefined) { fields.push('registrationNumber=?'); vals.push(registrationNumber || null); }
  if (verificationDate !== undefined) { fields.push('verificationDate=?'); vals.push(verificationDate || null); }
  if (expiryDate !== undefined) { fields.push('expiryDate=?'); vals.push(expiryDate || null); }
  if (sourceOfFundsSummary !== undefined) { fields.push('sourceOfFundsSummary=?'); vals.push(sourceOfFundsSummary || ''); }
  if (pepStatus !== undefined) { fields.push('pepStatus=?'); vals.push(pepStatus || null); }
  if (sanctionsCheckStatus !== undefined) { fields.push('sanctionsCheckStatus=?'); vals.push(sanctionsCheckStatus || null); }
  if (verifiedBy !== undefined) { fields.push('verifiedBy=?'); vals.push(verifiedBy || null); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes || ''); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  const now = new Date().toISOString();
  fields.push('updatedAt=?'); vals.push(now);
  fields.push('updatedBy=?'); vals.push(req.user.userId || '');
  vals.push(req.params.id);
  await run(`UPDATE client_kyc_records SET ${fields.join(', ')} WHERE id=?`, vals);
  const updated = await get(`${KYC_SELECT} WHERE r.id=?`, [req.params.id]);
  await recordAuditEvent(req, {
    action: 'client_kyc_record_updated',
    entityType: 'client_kyc_record',
    entityId: req.params.id,
    clientId: existing.clientId,
    metadata: kycAuditMetadata(updated),
  }).catch(() => {});
  res.json(publicKycRecord(updated));
});

app.delete('/api/client-kyc/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'kycCdd', 'KYC / CDD')) return;
  const existing = await get(`${KYC_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'KYC record not found' });
  if (!await canAccessKyc(req, existing.clientId)) return res.status(403).json({ error: 'KYC deactivate denied' });
  const now = new Date().toISOString();
  await run('UPDATE client_kyc_records SET isActive=0, deactivatedBy=?, deactivatedAt=?, updatedAt=? WHERE id=?', [req.user.userId || '', now, now, req.params.id]);
  await recordAuditEvent(req, {
    action: 'client_kyc_record_deactivated',
    entityType: 'client_kyc_record',
    entityId: req.params.id,
    clientId: existing.clientId,
    metadata: kycAuditMetadata(existing, 0),
  }).catch(() => {});
  res.json({ message: 'KYC record deactivated' });
});
// RET-31H: client authority record routes (module-gated, staff-only, metadata only).
app.get('/api/client-authorities', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'corporateAuthority', 'Corporate Authority')) return;
  const { clientId, status, includeInactive } = req.query;
  const conditions = [];
  const params = [];
  if (clientId) { conditions.push('r.clientId=?'); params.push(clientId); }
  if (status) { conditions.push('r.status=?'); params.push(status); }
  if (includeInactive !== 'true') { conditions.push('r.isActive=1'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`${AUTHORITY_SELECT} ${where} ORDER BY r.createdAt DESC`, params);
  const scoped = [];
  for (const row of rows) {
    if (await canAccessAuthority(req, row.clientId)) scoped.push(publicAuthorityRecord(row));
  }
  res.json(scoped);
});

app.get('/api/client-authorities/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'corporateAuthority', 'Corporate Authority')) return;
  const row = await get(`${AUTHORITY_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Authority record not found' });
  if (!await canAccessAuthority(req, row.clientId)) return res.status(403).json({ error: 'Authority access denied' });
  res.json(publicAuthorityRecord(row));
});

app.post('/api/client-authorities', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'corporateAuthority', 'Corporate Authority')) return;
  const validationError = validateAuthorityPayload(req.body, { partial: false });
  if (validationError) return res.status(400).json({ error: validationError });
  const client = await get('SELECT id FROM clients WHERE id=?', [req.body.clientId]);
  if (!client) return res.status(400).json({ error: 'Client not found' });
  if (!await canAccessAuthority(req, req.body.clientId)) return res.status(403).json({ error: 'Authority create denied' });
  const id = genId('AUT');
  const now = new Date().toISOString();
  await run(`INSERT INTO client_authority_records (id,clientId,status,authorityBasis,authorisedPersonName,authorisedPersonRole,authorisedPersonEmail,authorisedPersonPhone,authorityDate,expiryDate,notes,isActive,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [id, req.body.clientId, req.body.status || 'pending', req.body.authorityBasis || null,
     req.body.authorisedPersonName || null, req.body.authorisedPersonRole || null,
     req.body.authorisedPersonEmail || null, req.body.authorisedPersonPhone || null,
     req.body.authorityDate || null, req.body.expiryDate || null, req.body.notes || '',
     req.user.userId || '', now]);
  const row = await get(`${AUTHORITY_SELECT} WHERE r.id=?`, [id]);
  await recordAuditEvent(req, {
    action: 'client_authority_record_created',
    entityType: 'client_authority_record',
    entityId: id,
    clientId: req.body.clientId,
    metadata: authorityAuditMetadata(row),
  }).catch(() => {});
  res.status(201).json(publicAuthorityRecord(row));
});

app.patch('/api/client-authorities/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'corporateAuthority', 'Corporate Authority')) return;
  const existing = await get(`${AUTHORITY_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Authority record not found' });
  if (!await canAccessAuthority(req, existing.clientId)) return res.status(403).json({ error: 'Authority update denied' });
  if (req.body.clientId !== undefined && req.body.clientId !== existing.clientId) {
    return res.status(400).json({ error: 'clientId cannot be changed after creation' });
  }
  const validationError = validateAuthorityPayload(req.body, { partial: true });
  if (validationError) return res.status(400).json({ error: validationError });
  const { status, authorityBasis, authorisedPersonName, authorisedPersonRole, authorisedPersonEmail, authorisedPersonPhone, authorityDate, expiryDate, notes } = req.body;
  const fields = [];
  const vals = [];
  if (status !== undefined) { fields.push('status=?'); vals.push(status); }
  if (authorityBasis !== undefined) { fields.push('authorityBasis=?'); vals.push(authorityBasis || null); }
  if (authorisedPersonName !== undefined) { fields.push('authorisedPersonName=?'); vals.push(authorisedPersonName || null); }
  if (authorisedPersonRole !== undefined) { fields.push('authorisedPersonRole=?'); vals.push(authorisedPersonRole || null); }
  if (authorisedPersonEmail !== undefined) { fields.push('authorisedPersonEmail=?'); vals.push(authorisedPersonEmail || null); }
  if (authorisedPersonPhone !== undefined) { fields.push('authorisedPersonPhone=?'); vals.push(authorisedPersonPhone || null); }
  if (authorityDate !== undefined) { fields.push('authorityDate=?'); vals.push(authorityDate || null); }
  if (expiryDate !== undefined) { fields.push('expiryDate=?'); vals.push(expiryDate || null); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes || ''); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  const now = new Date().toISOString();
  fields.push('updatedAt=?'); vals.push(now);
  fields.push('updatedBy=?'); vals.push(req.user.userId || '');
  vals.push(req.params.id);
  await run(`UPDATE client_authority_records SET ${fields.join(', ')} WHERE id=?`, vals);
  const updated = await get(`${AUTHORITY_SELECT} WHERE r.id=?`, [req.params.id]);
  await recordAuditEvent(req, {
    action: 'client_authority_record_updated',
    entityType: 'client_authority_record',
    entityId: req.params.id,
    clientId: existing.clientId,
    metadata: authorityAuditMetadata(updated),
  }).catch(() => {});
  res.json(publicAuthorityRecord(updated));
});

app.delete('/api/client-authorities/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'corporateAuthority', 'Corporate Authority')) return;
  const existing = await get(`${AUTHORITY_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Authority record not found' });
  if (!await canAccessAuthority(req, existing.clientId)) return res.status(403).json({ error: 'Authority deactivate denied' });
  const now = new Date().toISOString();
  await run('UPDATE client_authority_records SET isActive=0, deactivatedBy=?, deactivatedAt=?, updatedAt=? WHERE id=?', [req.user.userId || '', now, now, req.params.id]);
  await recordAuditEvent(req, {
    action: 'client_authority_record_deactivated',
    entityType: 'client_authority_record',
    entityId: req.params.id,
    clientId: existing.clientId,
    metadata: authorityAuditMetadata({ ...existing, isActive: 0 }),
  }).catch(() => {});
  res.json({ message: 'Authority record deactivated' });
});

// RET-31I: retainer lifecycle event routes (append-only record; double module-gated; staff-only).
app.get('/api/retainer-lifecycle-events', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  if (!await requireEnabledModule(req, res, 'scopeVariation', 'Scope Variation')) return;
  const { clientId, matterId, retainerId, eventType, includeInactive } = req.query;
  const conditions = [];
  const params = [];
  if (clientId) { conditions.push('r.clientId=?'); params.push(clientId); }
  if (matterId) { conditions.push('r.matterId=?'); params.push(matterId); }
  if (retainerId) { conditions.push('r.retainerId=?'); params.push(retainerId); }
  if (eventType) { conditions.push('r.eventType=?'); params.push(eventType); }
  if (includeInactive !== 'true') { conditions.push('r.isActive=1'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`${LIFECYCLE_EVENT_SELECT} ${where} ORDER BY r.createdAt DESC`, params);
  const scoped = [];
  for (const row of rows) {
    if (await canAccessLifecycleEvent(req, row.clientId, row.matterId)) {
      scoped.push(publicLifecycleEvent(row));
    }
  }
  res.json(scoped);
});

app.get('/api/retainer-lifecycle-events/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  if (!await requireEnabledModule(req, res, 'scopeVariation', 'Scope Variation')) return;
  const row = await get(`${LIFECYCLE_EVENT_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Lifecycle event not found' });
  if (!await canAccessLifecycleEvent(req, row.clientId, row.matterId)) {
    return res.status(403).json({ error: 'Lifecycle event access denied' });
  }
  res.json(publicLifecycleEvent(row));
});

app.post('/api/retainer-lifecycle-events', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  if (!await requireEnabledModule(req, res, 'scopeVariation', 'Scope Variation')) return;
  const validationError = validateLifecycleEventPayload(req.body, { partial: false });
  if (validationError) return res.status(400).json({ error: validationError });
  const client = await get('SELECT id FROM clients WHERE id=?', [req.body.clientId]);
  if (!client) return res.status(400).json({ error: 'Client not found' });
  if (req.body.matterId) {
    const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [req.body.matterId]);
    if (!matter) return res.status(400).json({ error: 'Matter not found' });
    if (matter.clientId !== req.body.clientId) return res.status(400).json({ error: 'matterId does not belong to clientId' });
  }
  if (req.body.retainerId) {
    const ret = await get('SELECT id, clientId, matterId, isActive FROM retainer_records WHERE id=?', [req.body.retainerId]);
    if (!ret) return res.status(400).json({ error: 'Retainer not found' });
    if (Number(ret.isActive) !== 1) return res.status(400).json({ error: 'retainerId is not active' });
    if (ret.clientId !== req.body.clientId) return res.status(400).json({ error: 'retainerId does not belong to this client' });
    if (req.body.matterId && (ret.matterId || '') !== req.body.matterId) return res.status(400).json({ error: 'retainerId does not belong to this matter' });
  }
  if (!await canAccessLifecycleEvent(req, req.body.clientId, req.body.matterId)) {
    return res.status(403).json({ error: 'Lifecycle event create denied' });
  }
  const id = genId('LCE');
  const now = new Date().toISOString();
  await run(`INSERT INTO retainer_lifecycle_events (id,clientId,matterId,retainerId,eventType,status,effectiveDate,noticeDate,title,summary,reason,scopeBeforeSummary,scopeAfterSummary,clientObligationsSummary,firmObligationsSummary,isActive,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [id, req.body.clientId, req.body.matterId || null, req.body.retainerId || null, req.body.eventType, req.body.status || 'recorded',
     req.body.effectiveDate || null, req.body.noticeDate || null, req.body.title || null, req.body.summary || '', req.body.reason || '',
     req.body.scopeBeforeSummary || '', req.body.scopeAfterSummary || '', req.body.clientObligationsSummary || '', req.body.firmObligationsSummary || '',
     req.user.userId || '', now]);
  const row = await get(`${LIFECYCLE_EVENT_SELECT} WHERE r.id=?`, [id]);
  await recordAuditEvent(req, {
    action: 'retainer_lifecycle_event_created',
    entityType: 'retainer_lifecycle_event',
    entityId: id,
    clientId: req.body.clientId,
    matterId: req.body.matterId || '',
    metadata: lifecycleEventAuditMetadata(row),
  }).catch(() => {});
  res.status(201).json(publicLifecycleEvent(row));
});

app.patch('/api/retainer-lifecycle-events/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  if (!await requireEnabledModule(req, res, 'scopeVariation', 'Scope Variation')) return;
  const existing = await get(`${LIFECYCLE_EVENT_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Lifecycle event not found' });
  if (!await canAccessLifecycleEvent(req, existing.clientId, existing.matterId)) {
    return res.status(403).json({ error: 'Lifecycle event update denied' });
  }
  if (req.body.clientId !== undefined && req.body.clientId !== existing.clientId) {
    return res.status(400).json({ error: 'clientId cannot be changed after creation' });
  }
  const validationError = validateLifecycleEventPayload(req.body, { partial: true });
  if (validationError) return res.status(400).json({ error: validationError });
  const { status, effectiveDate, noticeDate, title, summary, reason, scopeBeforeSummary, scopeAfterSummary, clientObligationsSummary, firmObligationsSummary } = req.body;
  const fields = [];
  const vals = [];
  if (status !== undefined) { fields.push('status=?'); vals.push(status); }
  if (effectiveDate !== undefined) { fields.push('effectiveDate=?'); vals.push(effectiveDate || null); }
  if (noticeDate !== undefined) { fields.push('noticeDate=?'); vals.push(noticeDate || null); }
  if (title !== undefined) { fields.push('title=?'); vals.push(title || null); }
  if (summary !== undefined) { fields.push('summary=?'); vals.push(summary || ''); }
  if (reason !== undefined) { fields.push('reason=?'); vals.push(reason || ''); }
  if (scopeBeforeSummary !== undefined) { fields.push('scopeBeforeSummary=?'); vals.push(scopeBeforeSummary || ''); }
  if (scopeAfterSummary !== undefined) { fields.push('scopeAfterSummary=?'); vals.push(scopeAfterSummary || ''); }
  if (clientObligationsSummary !== undefined) { fields.push('clientObligationsSummary=?'); vals.push(clientObligationsSummary || ''); }
  if (firmObligationsSummary !== undefined) { fields.push('firmObligationsSummary=?'); vals.push(firmObligationsSummary || ''); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  const now = new Date().toISOString();
  fields.push('updatedAt=?'); vals.push(now);
  fields.push('updatedBy=?'); vals.push(req.user.userId || '');
  vals.push(req.params.id);
  await run(`UPDATE retainer_lifecycle_events SET ${fields.join(', ')} WHERE id=?`, vals);
  const updated = await get(`${LIFECYCLE_EVENT_SELECT} WHERE r.id=?`, [req.params.id]);
  await recordAuditEvent(req, {
    action: 'retainer_lifecycle_event_updated',
    entityType: 'retainer_lifecycle_event',
    entityId: req.params.id,
    clientId: existing.clientId,
    matterId: existing.matterId || '',
    metadata: lifecycleEventAuditMetadata(updated),
  }).catch(() => {});
  res.json(publicLifecycleEvent(updated));
});

app.delete('/api/retainer-lifecycle-events/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'retainerManagement', 'Retainer Management')) return;
  if (!await requireEnabledModule(req, res, 'scopeVariation', 'Scope Variation')) return;
  const existing = await get(`${LIFECYCLE_EVENT_SELECT} WHERE r.id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Lifecycle event not found' });
  if (!await canAccessLifecycleEvent(req, existing.clientId, existing.matterId)) {
    return res.status(403).json({ error: 'Lifecycle event deactivate denied' });
  }
  const now = new Date().toISOString();
  await run('UPDATE retainer_lifecycle_events SET isActive=0, deactivatedBy=?, deactivatedAt=?, updatedAt=? WHERE id=?',
    [req.user.userId || '', now, now, req.params.id]);
  await recordAuditEvent(req, {
    action: 'retainer_lifecycle_event_deactivated',
    entityType: 'retainer_lifecycle_event',
    entityId: req.params.id,
    clientId: existing.clientId,
    matterId: existing.matterId || '',
    metadata: lifecycleEventAuditMetadata({ ...existing, isActive: 0 }),
  }).catch(() => {});
  res.json({ message: 'Lifecycle event deactivated' });
});

// KENYA-32B: Legal Deadline Rule Library + stateless preview.
// Rules are advocate-verified planning DATA (no hard-coded Kenyan legal periods).
// Preview computes a suggested date but creates NO deadline/task/appearance/matter row.
const LEGAL_RULE_DISCLAIMER = 'This is a planning aid only. Confirm the applicable law, trigger date, exclusions, extensions, and court directions before relying on this date.';

function validateLegalDeadlineRulePayload(payload, { partial = false } = {}) {
  const p = payload || {};
  const has = k => p[k] !== undefined && p[k] !== null;
  if (!partial) {
    if (!p.ruleType) return 'ruleType is required';
    if (!p.title) return 'title is required';
    if (!p.triggerEvent) return 'triggerEvent is required';
    if (p.periodValue === undefined || p.periodValue === null || p.periodValue === '') return 'periodValue is required';
    if (!p.periodUnit) return 'periodUnit is required';
    if (!p.citation) return 'citation is required';
  }
  if (has('ruleType') && p.ruleType !== '' && !ALLOWED_LEGAL_RULE_TYPES.has(p.ruleType)) return `Invalid ruleType. Allowed: ${[...ALLOWED_LEGAL_RULE_TYPES].join(', ')}`;
  if (has('periodUnit') && p.periodUnit !== '' && !ALLOWED_LEGAL_RULE_PERIOD_UNITS.has(p.periodUnit)) return `Invalid periodUnit. Allowed: ${[...ALLOWED_LEGAL_RULE_PERIOD_UNITS].join(', ')}`;
  if (has('computationMode') && p.computationMode !== '' && !ALLOWED_LEGAL_RULE_COMPUTATION_MODES.has(p.computationMode)) return `Invalid computationMode. Allowed: ${[...ALLOWED_LEGAL_RULE_COMPUTATION_MODES].join(', ')}`;
  if (p.periodValue !== undefined && p.periodValue !== null && p.periodValue !== '') {
    const pv = Number(p.periodValue);
    if (!Number.isInteger(pv) || pv <= 0) return 'periodValue must be a positive integer';
  }
  if (p.version !== undefined && p.version !== null && p.version !== '') {
    const v = Number(p.version);
    if (!Number.isInteger(v) || v <= 0) return 'version must be a positive integer';
  }
  if ((p.jurisdiction || '').length > 100) return 'jurisdiction exceeds 100 characters';
  if ((p.legalArea || '').length > 160) return 'legalArea exceeds 160 characters';
  if ((p.causeOfAction || '').length > 200) return 'causeOfAction exceeds 200 characters';
  if ((p.title || '').length > 240) return 'title exceeds 240 characters';
  if ((p.triggerEvent || '').length > 160) return 'triggerEvent exceeds 160 characters';
  if ((p.citation || '').length > 1000) return 'citation exceeds 1000 characters';
  if ((p.notes || '').length > 5000) return 'notes exceeds 5000 characters';
  if ((p.verifiedBy || '').length > 160) return 'verifiedBy exceeds 160 characters';
  if (has('effectiveFrom') && p.effectiveFrom !== '' && Number.isNaN(new Date(p.effectiveFrom).getTime())) return 'Invalid effectiveFrom';
  if (has('effectiveTo') && p.effectiveTo !== '' && Number.isNaN(new Date(p.effectiveTo).getTime())) return 'Invalid effectiveTo';
  if (has('verifiedAt') && p.verifiedAt !== '' && Number.isNaN(new Date(p.verifiedAt).getTime())) return 'Invalid verifiedAt';
  return null;
}

function publicLegalDeadlineRule(row) {
  return {
    id: row.id,
    ruleType: row.ruleType || '',
    jurisdiction: row.jurisdiction || '',
    legalArea: row.legalArea || '',
    causeOfAction: row.causeOfAction || '',
    title: row.title || '',
    triggerEvent: row.triggerEvent || '',
    periodValue: Number(row.periodValue || 0),
    periodUnit: row.periodUnit || '',
    computationMode: row.computationMode || 'calendar',
    citation: row.citation || '',
    notes: row.notes || '',
    effectiveFrom: row.effectiveFrom || '',
    effectiveTo: row.effectiveTo || '',
    version: Number(row.version || 1),
    isActive: Number(row.isActive || 0) === 1,
    verifiedBy: row.verifiedBy || '',
    verifiedAt: row.verifiedAt || '',
    // KENYA-32D: advocate/admin review controls.
    reviewStatus: row.reviewStatus || 'pending',
    reviewedBy: row.reviewedBy || '',
    reviewedAt: row.reviewedAt || '',
    nextReviewDate: row.nextReviewDate || '',
    reviewComment: row.reviewComment || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    deactivatedAt: row.deactivatedAt || '',
  };
}

// KENYA-32B: stateless calendar arithmetic. days/months/years only; NO court days,
// weekends, public holidays, excluded days, or filing-service cascade logic.
function computePreviewDueDate(triggerDate, periodValue, periodUnit) {
  const base = new Date(`${String(triggerDate || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  const n = Number(periodValue);
  if (!Number.isInteger(n) || n <= 0) return null;
  const d = new Date(base.getTime());
  if (periodUnit === 'days') {
    d.setUTCDate(d.getUTCDate() + n);
  } else if (periodUnit === 'months') {
    const day = d.getUTCDate();
    const total = d.getUTCMonth() + n;
    const targetYear = d.getUTCFullYear() + Math.floor(total / 12);
    const targetMonth = ((total % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    d.setUTCFullYear(targetYear, targetMonth, Math.min(day, lastDay));
  } else if (periodUnit === 'years') {
    const day = d.getUTCDate();
    const month = d.getUTCMonth();
    const targetYear = d.getUTCFullYear() + n;
    const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
    d.setUTCFullYear(targetYear, month, Math.min(day, lastDay));
  } else {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

// KENYA-32B: whitelist audit metadata (excludes notes / long legal analysis / free text).
function legalDeadlineRuleAuditMetadata(row, isActiveOverride) {
  return {
    ruleId: row.id,
    ruleType: row.ruleType || '',
    jurisdiction: row.jurisdiction || '',
    legalArea: row.legalArea || '',
    causeOfAction: row.causeOfAction || '',
    citation: row.citation || '',
    version: Number(row.version || 1),
    isActive: isActiveOverride !== undefined ? isActiveOverride : Number(row.isActive || 0),
  };
}

app.get('/api/legal-deadline-rules', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const { ruleType, jurisdiction, legalArea, includeInactive } = req.query;
  const conditions = [];
  const params = [];
  if (ruleType) { conditions.push('ruleType=?'); params.push(ruleType); }
  if (jurisdiction) { conditions.push('jurisdiction=?'); params.push(jurisdiction); }
  if (legalArea) { conditions.push('legalArea=?'); params.push(legalArea); }
  if (includeInactive !== 'true') { conditions.push('isActive=1'); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`SELECT * FROM legal_deadline_rules ${where} ORDER BY createdAt DESC`, params);
  res.json(rows.map(publicLegalDeadlineRule));
});

app.post('/api/legal-deadline-rules', requireAdmin, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const validationError = validateLegalDeadlineRulePayload(req.body, { partial: false });
  if (validationError) return res.status(400).json({ error: validationError });
  const { ruleType, jurisdiction, legalArea, causeOfAction, title, triggerEvent, periodValue, periodUnit,
    computationMode, citation, notes, effectiveFrom, effectiveTo, version, verifiedBy, verifiedAt } = req.body;
  const id = genId('LDR');
  const now = new Date().toISOString();
  await run(`INSERT INTO legal_deadline_rules (id,ruleType,jurisdiction,legalArea,causeOfAction,title,triggerEvent,periodValue,periodUnit,computationMode,citation,notes,effectiveFrom,effectiveTo,version,isActive,verifiedBy,verifiedAt,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
    [id, ruleType, jurisdiction || 'Kenya', legalArea || null, causeOfAction || null, title, triggerEvent, Number(periodValue), periodUnit,
     computationMode || 'calendar', citation, notes || '', effectiveFrom || null, effectiveTo || null,
     version === undefined || version === null || version === '' ? 1 : Number(version), verifiedBy || null, verifiedAt || null, req.user.userId || '', now]);
  const row = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [id]);
  await recordAuditEvent(req, {
    action: 'legal_deadline_rule_created',
    entityType: 'legal_deadline_rule',
    entityId: id,
    metadata: legalDeadlineRuleAuditMetadata(row, 1),
  }).catch(() => {});
  res.status(201).json(publicLegalDeadlineRule(row));
});

app.patch('/api/legal-deadline-rules/:id', requireAdmin, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const existing = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Legal deadline rule not found' });
  const validationError = validateLegalDeadlineRulePayload(req.body, { partial: true });
  if (validationError) return res.status(400).json({ error: validationError });
  const { ruleType, jurisdiction, legalArea, causeOfAction, title, triggerEvent, periodValue, periodUnit,
    computationMode, citation, notes, effectiveFrom, effectiveTo, version, verifiedBy, verifiedAt } = req.body;
  const fields = [];
  const vals = [];
  if (ruleType !== undefined) { fields.push('ruleType=?'); vals.push(ruleType); }
  if (jurisdiction !== undefined) { fields.push('jurisdiction=?'); vals.push(jurisdiction || 'Kenya'); }
  if (legalArea !== undefined) { fields.push('legalArea=?'); vals.push(legalArea || null); }
  if (causeOfAction !== undefined) { fields.push('causeOfAction=?'); vals.push(causeOfAction || null); }
  if (title !== undefined) { fields.push('title=?'); vals.push(title); }
  if (triggerEvent !== undefined) { fields.push('triggerEvent=?'); vals.push(triggerEvent); }
  if (periodValue !== undefined) { fields.push('periodValue=?'); vals.push(Number(periodValue)); }
  if (periodUnit !== undefined) { fields.push('periodUnit=?'); vals.push(periodUnit); }
  if (computationMode !== undefined) { fields.push('computationMode=?'); vals.push(computationMode || 'calendar'); }
  if (citation !== undefined) { fields.push('citation=?'); vals.push(citation); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes || ''); }
  if (effectiveFrom !== undefined) { fields.push('effectiveFrom=?'); vals.push(effectiveFrom || null); }
  if (effectiveTo !== undefined) { fields.push('effectiveTo=?'); vals.push(effectiveTo || null); }
  if (version !== undefined) { fields.push('version=?'); vals.push(version === null || version === '' ? 1 : Number(version)); }
  if (verifiedBy !== undefined) { fields.push('verifiedBy=?'); vals.push(verifiedBy || null); }
  if (verifiedAt !== undefined) { fields.push('verifiedAt=?'); vals.push(verifiedAt || null); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  const now = new Date().toISOString();
  fields.push('updatedAt=?'); vals.push(now);
  fields.push('updatedBy=?'); vals.push(req.user.userId || '');
  vals.push(req.params.id);
  await run(`UPDATE legal_deadline_rules SET ${fields.join(', ')} WHERE id=?`, vals);
  const updated = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [req.params.id]);
  await recordAuditEvent(req, {
    action: 'legal_deadline_rule_updated',
    entityType: 'legal_deadline_rule',
    entityId: req.params.id,
    metadata: legalDeadlineRuleAuditMetadata(updated),
  }).catch(() => {});
  res.json(publicLegalDeadlineRule(updated));
});

app.delete('/api/legal-deadline-rules/:id', requireAdmin, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const existing = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Legal deadline rule not found' });
  const now = new Date().toISOString();
  await run('UPDATE legal_deadline_rules SET isActive=0, deactivatedBy=?, deactivatedAt=?, updatedBy=?, updatedAt=? WHERE id=?',
    [req.user.userId || '', now, req.user.userId || '', now, req.params.id]);
  await recordAuditEvent(req, {
    action: 'legal_deadline_rule_deactivated',
    entityType: 'legal_deadline_rule',
    entityId: req.params.id,
    metadata: legalDeadlineRuleAuditMetadata(existing, 0),
  }).catch(() => {});
  res.json({ message: 'Legal deadline rule deactivated' });
});

// KENYA-32D: advocate/admin review controls. Records review metadata only — does NOT
// change deadline computation, suggestions, reactivate an inactive rule, or create deadlines.
app.patch('/api/legal-deadline-rules/:id/review', requireAdvocateOrAdmin, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const existing = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Legal deadline rule not found' });
  const { reviewStatus, nextReviewDate, reviewComment } = req.body || {};
  if (!reviewStatus || !ALLOWED_LEGAL_RULE_REVIEW_STATUSES.has(reviewStatus)) {
    return res.status(400).json({ error: `Invalid reviewStatus. Allowed: ${[...ALLOWED_LEGAL_RULE_REVIEW_STATUSES].join(', ')}` });
  }
  let normalizedNextReview = null;
  if (nextReviewDate !== undefined && nextReviewDate !== null && nextReviewDate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(nextReviewDate)) || Number.isNaN(new Date(`${nextReviewDate}T00:00:00.000Z`).getTime())) {
      return res.status(400).json({ error: 'nextReviewDate must be a valid YYYY-MM-DD date' });
    }
    normalizedNextReview = String(nextReviewDate);
  }
  let normalizedComment = '';
  if (reviewComment !== undefined && reviewComment !== null) {
    normalizedComment = String(reviewComment).trim();
    if (normalizedComment.length > 500) return res.status(400).json({ error: 'reviewComment exceeds 500 characters' });
  }
  const now = new Date().toISOString();
  // isActive is intentionally not touched — reviewing an inactive rule does not reactivate it.
  await run('UPDATE legal_deadline_rules SET reviewStatus=?, reviewedBy=?, reviewedAt=?, nextReviewDate=?, reviewComment=?, updatedBy=?, updatedAt=? WHERE id=?',
    [reviewStatus, req.user.userId || '', now, normalizedNextReview, normalizedComment, req.user.userId || '', now, req.params.id]);
  const updated = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [req.params.id]);
  await recordAuditEvent(req, {
    action: 'legal_deadline_rule_reviewed',
    entityType: 'legal_deadline_rule',
    entityId: req.params.id,
    metadata: {
      ruleId: updated.id,
      reviewStatus: updated.reviewStatus || '',
      nextReviewDate: updated.nextReviewDate || '',
      jurisdiction: updated.jurisdiction || '',
      ruleType: updated.ruleType || '',
      legalArea: updated.legalArea || '',
    },
  }).catch(() => {});
  res.json(publicLegalDeadlineRule(updated));
});

app.post('/api/legal-deadline-rules/:id/preview', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const rule = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [req.params.id]);
  if (!rule || Number(rule.isActive || 0) !== 1) return res.status(404).json({ error: 'Legal deadline rule not found' });
  const { triggerDate, matterId } = req.body || {};
  if (!triggerDate || Number.isNaN(new Date(triggerDate).getTime())) return res.status(400).json({ error: 'A valid triggerDate is required' });
  if (matterId) {
    const matter = await get('SELECT id FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, matterId, metadata: { reason: 'insufficient permissions', route: 'legal_deadline_rule_preview' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }
  }
  const suggestedDueDate = computePreviewDueDate(triggerDate, rule.periodValue, rule.periodUnit);
  if (!suggestedDueDate) return res.status(400).json({ error: 'Unable to compute a suggested date from this rule and trigger date' });
  await recordAuditEvent(req, {
    action: 'deadline_suggestion_previewed',
    entityType: 'legal_deadline_rule',
    entityId: rule.id,
    matterId: matterId || '',
    metadata: {
      ruleId: rule.id,
      matterId: matterId || '',
      triggerDate: String(triggerDate).slice(0, 10),
      suggestedDueDate,
      periodValue: Number(rule.periodValue || 0),
      periodUnit: rule.periodUnit || '',
      computationMode: rule.computationMode || 'calendar',
    },
  }).catch(() => {});
  res.json({
    ruleId: rule.id,
    title: rule.title || '',
    ruleType: rule.ruleType || '',
    jurisdiction: rule.jurisdiction || '',
    legalArea: rule.legalArea || '',
    causeOfAction: rule.causeOfAction || '',
    triggerEvent: rule.triggerEvent || '',
    triggerDate: String(triggerDate).slice(0, 10),
    periodValue: Number(rule.periodValue || 0),
    periodUnit: rule.periodUnit || '',
    computationMode: rule.computationMode || 'calendar',
    suggestedDueDate,
    citation: rule.citation || '',
    requiresAdvocateVerification: true,
    disclaimer: LEGAL_RULE_DISCLAIMER,
  });
});

// ---------------------------------------------------------------------------
// KENYA-32C: persisted legal deadline suggestions + explicit confirm-to-deadline.
// Suggestions snapshot a KENYA-32B rule + trigger date and remain internal planning
// aids. Confirmation (advocate/admin only) creates EXACTLY ONE row in `deadlines`.
// No recurring/cascade automation, no hard-coded periods, no client-portal exposure.
// ---------------------------------------------------------------------------
function publicLegalDeadlineSuggestion(row) {
  return {
    id: row.id,
    ruleId: row.ruleId,
    matterId: row.matterId || '',
    clientId: row.clientId || '',
    triggerDate: row.triggerDate || '',
    suggestedDueDate: row.suggestedDueDate || '',
    title: row.title || '',
    ruleType: row.ruleType || '',
    jurisdiction: row.jurisdiction || '',
    legalArea: row.legalArea || '',
    causeOfAction: row.causeOfAction || '',
    triggerEvent: row.triggerEvent || '',
    periodValue: Number(row.periodValue || 0),
    periodUnit: row.periodUnit || '',
    computationMode: row.computationMode || 'calendar',
    citation: row.citation || '',
    disclaimer: row.disclaimer || '',
    requiresAdvocateVerification: Number(row.requiresAdvocateVerification || 0) === 1,
    status: row.status || 'draft',
    confirmedDeadlineId: row.confirmedDeadlineId || '',
    notes: row.notes || '',
    createdBy: row.createdBy || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    confirmedAt: row.confirmedAt || '',
    cancelledAt: row.cancelledAt || '',
  };
}

// Whitelisted audit metadata: NO notes / legal analysis / private free text.
function legalDeadlineSuggestionAuditMetadata(row) {
  return {
    suggestionId: row.id,
    ruleId: row.ruleId || '',
    matterId: row.matterId || '',
    clientId: row.clientId || '',
    status: row.status || '',
    suggestedDueDate: row.suggestedDueDate || '',
    confirmedDeadlineId: row.confirmedDeadlineId || '',
    citation: row.citation || '',
    ruleType: row.ruleType || '',
    jurisdiction: row.jurisdiction || '',
  };
}

function validateLegalDeadlineSuggestionPayload(payload, { partial = false } = {}) {
  const p = payload || {};
  if (!partial) {
    if (!p.ruleId) return 'ruleId is required';
    if (!p.triggerDate || Number.isNaN(new Date(p.triggerDate).getTime())) return 'A valid triggerDate is required';
  }
  if (p.title !== undefined && p.title !== null && String(p.title).length > 240) return 'title exceeds 240 characters';
  if (p.notes !== undefined && p.notes !== null && String(p.notes).length > 5000) return 'notes exceeds 5000 characters';
  return null;
}

app.get('/api/legal-deadline-suggestions', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const { matterId, clientId, status, ruleId } = req.query;
  // Enforce access on supplied scope filters (advocate scoping).
  if (matterId) {
    const matter = await get('SELECT id FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, matterId, metadata: { reason: 'insufficient permissions', route: 'legal_deadline_suggestions_list' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }
  } else if (clientId) {
    const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!(await canAccessClient(req, clientId))) {
      await recordAuditEvent(req, { action: 'forbidden_client_access', entityType: 'client', entityId: clientId, clientId, metadata: { reason: 'insufficient permissions', route: 'legal_deadline_suggestions_list' } }).catch(() => {});
      return res.status(403).json({ error: 'Client access denied' });
    }
  }
  const conditions = [];
  const params = [];
  if (matterId) { conditions.push('matterId=?'); params.push(matterId); }
  if (clientId) { conditions.push('clientId=?'); params.push(clientId); }
  if (status) { conditions.push('status=?'); params.push(status); }
  if (ruleId) { conditions.push('ruleId=?'); params.push(ruleId); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await all(`SELECT * FROM legal_deadline_suggestions ${where} ORDER BY suggestedDueDate ASC, createdAt DESC`, params);
  // Advocates only see suggestions they can reach when no accessible filter was applied.
  let visible = rows;
  if (req.user.role === 'advocate' && !matterId && !clientId) {
    const filtered = [];
    for (const row of rows) {
      if (row.matterId) { if (await canAccessMatter(req, row.matterId)) filtered.push(row); }
      else if (row.clientId) { if (await canAccessClient(req, row.clientId)) filtered.push(row); }
      else if (row.createdBy === req.user.userId) filtered.push(row);
    }
    visible = filtered;
  }
  res.json(visible.map(publicLegalDeadlineSuggestion));
});

app.post('/api/legal-deadline-suggestions', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const validationError = validateLegalDeadlineSuggestionPayload(req.body, { partial: false });
  if (validationError) return res.status(400).json({ error: validationError });
  const { ruleId, matterId, clientId, triggerDate, title, notes } = req.body || {};
  const rule = await get('SELECT * FROM legal_deadline_rules WHERE id=?', [ruleId]);
  if (!rule || Number(rule.isActive || 0) !== 1) return res.status(404).json({ error: 'Legal deadline rule not found' });
  let resolvedClientId = clientId || null;
  if (matterId) {
    const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [matterId]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, matterId))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: matterId, matterId, metadata: { reason: 'insufficient permissions', route: 'legal_deadline_suggestion_create' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }
    resolvedClientId = matter.clientId || clientId || null;
  } else if (clientId) {
    const client = await get('SELECT id FROM clients WHERE id=?', [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!(await canAccessClient(req, clientId))) {
      await recordAuditEvent(req, { action: 'forbidden_client_access', entityType: 'client', entityId: clientId, clientId, metadata: { reason: 'insufficient permissions', route: 'legal_deadline_suggestion_create' } }).catch(() => {});
      return res.status(403).json({ error: 'Client access denied' });
    }
  }
  const suggestedDueDate = computePreviewDueDate(triggerDate, rule.periodValue, rule.periodUnit);
  if (!suggestedDueDate) return res.status(400).json({ error: 'Unable to compute a suggested date from this rule and trigger date' });
  const id = genId('LDS');
  const now = new Date().toISOString();
  const resolvedTitle = (title && String(title).trim()) ? String(title).trim() : (rule.title || '');
  await run(`INSERT INTO legal_deadline_suggestions (id,ruleId,matterId,clientId,triggerDate,suggestedDueDate,title,ruleType,jurisdiction,legalArea,causeOfAction,triggerEvent,periodValue,periodUnit,computationMode,citation,disclaimer,requiresAdvocateVerification,status,notes,createdBy,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, rule.id, matterId || null, resolvedClientId, String(triggerDate).slice(0, 10), suggestedDueDate,
     resolvedTitle, rule.ruleType || '', rule.jurisdiction || '', rule.legalArea || null, rule.causeOfAction || null,
     rule.triggerEvent || '', Number(rule.periodValue || 0), rule.periodUnit || '', rule.computationMode || 'calendar',
     rule.citation || '', LEGAL_RULE_DISCLAIMER, 1, 'draft', notes || '', req.user.userId || '', now]);
  const row = await get('SELECT * FROM legal_deadline_suggestions WHERE id=?', [id]);
  await recordAuditEvent(req, {
    action: 'legal_deadline_suggestion_created',
    entityType: 'legal_deadline_suggestion',
    entityId: id,
    matterId: matterId || '',
    clientId: resolvedClientId || '',
    metadata: legalDeadlineSuggestionAuditMetadata(row),
  }).catch(() => {});
  res.status(201).json(publicLegalDeadlineSuggestion(row));
});

app.patch('/api/legal-deadline-suggestions/:id', requireStaff, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const existing = await get('SELECT * FROM legal_deadline_suggestions WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Suggestion not found' });
  if (existing.status !== 'draft') return res.status(409).json({ error: `Suggestion is ${existing.status} and can no longer be edited` });
  if (req.user.role === 'advocate') {
    if (existing.matterId) { if (!(await canAccessMatter(req, existing.matterId))) return res.status(403).json({ error: 'Matter access denied' }); }
    else if (existing.clientId) { if (!(await canAccessClient(req, existing.clientId))) return res.status(403).json({ error: 'Client access denied' }); }
    else if (existing.createdBy !== req.user.userId) return res.status(403).json({ error: 'Suggestion access denied' });
  }
  const { title, notes, status } = req.body || {};
  if (status !== undefined && status !== 'cancelled') return res.status(400).json({ error: 'Only cancellation is permitted via status; use the confirm route to confirm' });
  const lengthError = validateLegalDeadlineSuggestionPayload(req.body, { partial: true });
  if (lengthError) return res.status(400).json({ error: lengthError });
  const now = new Date().toISOString();
  if (status === 'cancelled') {
    await run('UPDATE legal_deadline_suggestions SET status=?, cancelledBy=?, cancelledAt=?, updatedBy=?, updatedAt=? WHERE id=? AND status=?',
      ['cancelled', req.user.userId || '', now, req.user.userId || '', now, req.params.id, 'draft']);
    const updated = await get('SELECT * FROM legal_deadline_suggestions WHERE id=?', [req.params.id]);
    await recordAuditEvent(req, {
      action: 'legal_deadline_suggestion_cancelled',
      entityType: 'legal_deadline_suggestion',
      entityId: req.params.id,
      matterId: updated.matterId || '',
      clientId: updated.clientId || '',
      metadata: legalDeadlineSuggestionAuditMetadata(updated),
    }).catch(() => {});
    return res.json(publicLegalDeadlineSuggestion(updated));
  }
  const fields = [];
  const vals = [];
  if (title !== undefined) { fields.push('title=?'); vals.push((title && String(title).trim()) ? String(title).trim() : existing.title); }
  if (notes !== undefined) { fields.push('notes=?'); vals.push(notes || ''); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  fields.push('updatedBy=?'); vals.push(req.user.userId || '');
  fields.push('updatedAt=?'); vals.push(now);
  vals.push(req.params.id);
  await run(`UPDATE legal_deadline_suggestions SET ${fields.join(', ')} WHERE id=?`, vals);
  const updated = await get('SELECT * FROM legal_deadline_suggestions WHERE id=?', [req.params.id]);
  await recordAuditEvent(req, {
    action: 'legal_deadline_suggestion_updated',
    entityType: 'legal_deadline_suggestion',
    entityId: req.params.id,
    matterId: updated.matterId || '',
    clientId: updated.clientId || '',
    metadata: legalDeadlineSuggestionAuditMetadata(updated),
  }).catch(() => {});
  res.json(publicLegalDeadlineSuggestion(updated));
});

app.post('/api/legal-deadline-suggestions/:id/confirm', requireAdvocateOrAdmin, async (req, res) => {
  if (!await requireEnabledModule(req, res, 'advancedCompliance', 'Advanced Compliance')) return;
  const existing = await get('SELECT * FROM legal_deadline_suggestions WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Suggestion not found' });
  if (existing.status !== 'draft') return res.status(409).json({ error: `Suggestion is already ${existing.status}` });
  if (!existing.matterId) return res.status(400).json({ error: 'A matterId is required before confirming a suggestion' });
  const matter = await get('SELECT id, clientId FROM matters WHERE id=?', [existing.matterId]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  if (!(await canAccessMatter(req, existing.matterId))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: existing.matterId, matterId: existing.matterId, metadata: { reason: 'insufficient permissions', route: 'legal_deadline_suggestion_confirm' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  const deadlineId = genId('DL');
  const now = new Date().toISOString();
  const clientId = existing.clientId || matter.clientId || '';
  const deadlineNotes = `Created from legal deadline suggestion. Citation: ${existing.citation || ''}. Confirm applicable law before reliance.`;
  await run('BEGIN TRANSACTION');
  try {
    const fresh = await get('SELECT status FROM legal_deadline_suggestions WHERE id=?', [req.params.id]);
    if (!fresh || fresh.status !== 'draft') {
      await run('ROLLBACK').catch(() => {});
      return res.status(409).json({ error: 'Suggestion is no longer in draft status' });
    }
    await run('INSERT INTO deadlines (id,matterId,clientId,title,type,dueDate,owner,status,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [deadlineId, existing.matterId, clientId, existing.title, 'Legal Deadline', existing.suggestedDueDate, req.user.fullName || req.user.email || '', 'Open', deadlineNotes, req.user.userId || '', now]);
    const upd = await run('UPDATE legal_deadline_suggestions SET status=?, confirmedDeadlineId=?, confirmedBy=?, confirmedAt=?, updatedBy=?, updatedAt=? WHERE id=? AND status=?',
      ['confirmed', deadlineId, req.user.userId || '', now, req.user.userId || '', now, req.params.id, 'draft']);
    if (!upd || upd.changes !== 1) {
      await run('ROLLBACK').catch(() => {});
      return res.status(409).json({ error: 'Suggestion could not be confirmed (already processed)' });
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  }
  const updatedSuggestion = await get('SELECT * FROM legal_deadline_suggestions WHERE id=?', [req.params.id]);
  const deadline = await get('SELECT * FROM deadlines WHERE id=?', [deadlineId]);
  await recordAuditEvent(req, {
    action: 'legal_deadline_suggestion_confirmed',
    entityType: 'legal_deadline_suggestion',
    entityId: req.params.id,
    matterId: existing.matterId || '',
    clientId: clientId || '',
    metadata: legalDeadlineSuggestionAuditMetadata(updatedSuggestion),
  }).catch(() => {});
  await logAudit(req, 'create', 'deadline', deadlineId, `Created Legal Deadline ${existing.title} from suggestion`).catch(() => {});
  res.json({ suggestion: publicLegalDeadlineSuggestion(updatedSuggestion), deadline });
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
  const [tasks, timeEntries, documents, notes, invoices, appearances, checklistItems, appearancePrepItems] = await Promise.all([
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM tasks WHERE matterId=? ORDER BY dueDate', [req.params.id]),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM time_entries WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE ${documentWhere} ORDER BY d.date DESC`, documentParams),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id]),
    all('SELECT * FROM invoices WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT * FROM appearances WHERE matterId=? ORDER BY date', [req.params.id]),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM matter_checklist_items WHERE matterId=? ORDER BY position ASC, createdAt ASC', [req.params.id]),
    req.user.role === 'client' ? Promise.resolve([]) : all('SELECT * FROM appearance_prep_items WHERE matterId=? ORDER BY createdAt ASC', [req.params.id])
  ]);
  await attachInvoiceSummaries(invoices);
  if (req.user.role === 'advocate' && !(await isBillingVisibleFor(req))) {
    matter.totalBilled = null;
    matter.fixedFee = null;
    for (const te of timeEntries) te.rate = null;
    for (const inv of invoices) maskInvoiceBilling(inv);
  }
  if (req.user.role === 'client') {
    appearances.forEach(stripStaffAppearanceFields);
  }
  if (req.user.role !== 'client' && appearancePrepItems.length) {
    const prepByAppearance = new Map();
    for (const item of appearancePrepItems) {
      if (!prepByAppearance.has(item.appearanceId)) prepByAppearance.set(item.appearanceId, []);
      prepByAppearance.get(item.appearanceId).push(item);
    }
    appearances.forEach(a => { a.prepItems = prepByAppearance.get(a.id) || []; });
  }
  const payload = { ...matter, tasks, timeEntries, documents: documents.map(publicDocument), notes, invoices, appearances };
  if (req.user.role !== 'client') payload.checklistItems = checklistItems;
  res.json(payload);
});

// TIMELINE-30B: unified, read-only, staff-only matter timeline aggregated from existing data.
const MATTER_TIMELINE_TYPES = new Set(['matter_opened', 'note', 'task', 'appearance', 'document', 'time_entry', 'invoice', 'deadline', 'payment', 'checklist', 'stage_change']);

// TIMELINE-30D: record a matter stage change (no-op when unchanged). Captures future
// changes only; matters.stage remains the source of truth. note is never audited.
async function recordMatterStageChange(req, { matterId, oldStage, newStage, source = 'manual', note = '' }) {
  const oldVal = oldStage == null ? '' : String(oldStage);
  const newVal = newStage == null ? '' : String(newStage);
  if (oldVal === newVal) return;
  const now = new Date().toISOString();
  const id = genId('MSH');
  await run(
    `INSERT INTO matter_stage_history (id, matterId, oldStage, newStage, changedBy, changedByName, changedAt, source, note, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, matterId, oldVal, newVal, req.user?.userId || '', req.user?.fullName || '', now, source, typeof note === 'string' ? note : '', now],
  );
  await recordAuditEvent(req, {
    action: 'matter_stage_changed',
    entityType: 'matter',
    entityId: matterId,
    metadata: { matterId, oldStage: oldVal, newStage: newVal, changedBy: req.user?.userId || '', source },
  }).catch(() => {});
}
const MATTER_TIMELINE_DEFAULT_LIMIT = 200;
const MATTER_TIMELINE_MAX_LIMIT = 500;

function timelineSummaryText(value, max = 200) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Builds a safe, normalized, descending-sorted event list for one matter.
// `showMoney` controls whether monetary fields are included (billing visibility).
async function buildMatterTimeline(matterId, { showMoney }) {
  const events = [];
  const push = (date, type, title, summary, actor, sourceId, sourceType, metadata = {}) => {
    events.push({ id: `${type}:${sourceId}`, type, title, date: date || '', summary: summary || '', actor: actor || '', sourceId: sourceId || '', sourceType, matterId, metadata });
  };

  const matter = await get('SELECT id, reference, title, openDate, assignedTo, paralegal FROM matters WHERE id=?', [matterId]);
  if (matter && matter.openDate) {
    push(matter.openDate, 'matter_opened', 'Matter opened', timelineSummaryText(matter.reference || matter.title || ''), matter.assignedTo || matter.paralegal || '', matter.id, 'matter', { reference: matter.reference || '' });
  }

  const [notes, tasks, appearances, documents, timeEntries, invoices, deadlines, payments, checklist, stageHistory] = await Promise.all([
    all('SELECT id, content, author, createdAt FROM case_notes WHERE matterId=?', [matterId]),
    all('SELECT id, title, completed, assignee, dueDate FROM tasks WHERE matterId=?', [matterId]),
    all('SELECT id, title, date, time, type, location, attorney FROM appearances WHERE matterId=?', [matterId]),
    all('SELECT id, name, displayName, type, mimeType, source, clientVisible, date, generatedAt, uploadedBy, generatedBy FROM documents WHERE matterId=? AND deletedAt IS NULL', [matterId]),
    all('SELECT id, date, hours, activity, attorney, rate, billable FROM time_entries WHERE matterId=?', [matterId]),
    all('SELECT id, number, status, date, dueDate, amount FROM invoices WHERE matterId=?', [matterId]),
    all('SELECT id, title, type, dueDate, status, owner, createdAt FROM deadlines WHERE matterId=?', [matterId]),
    all('SELECT id, method, reference, date, amount, createdBy, createdAt FROM payments WHERE matterId=?', [matterId]),
    all('SELECT id, title, completed, dueDate, assignee, createdAt, completedAt, completedBy FROM matter_checklist_items WHERE matterId=?', [matterId]),
    all('SELECT id, oldStage, newStage, changedByName, changedAt, source FROM matter_stage_history WHERE matterId=?', [matterId]),
  ]);

  for (const n of notes) {
    push(n.createdAt, 'note', 'Case note recorded', timelineSummaryText(n.content), n.author || '', n.id, 'case_note', {});
  }
  for (const t of tasks) {
    const status = t.completed ? 'completed' : 'open';
    push(t.dueDate, 'task', t.completed ? 'Task completed' : 'Task due', timelineSummaryText(t.title), t.assignee || '', t.id, 'task', { status });
  }
  for (const a of appearances) {
    push(a.date, 'appearance', 'Court appearance', timelineSummaryText([a.title || a.type, a.time, a.location].filter(Boolean).join(' · ')), a.attorney || '', a.id, 'appearance', { type: a.type || '', location: a.location || '', time: a.time || '' });
  }
  for (const d of documents) {
    push(d.date || d.generatedAt, 'document', d.generatedAt ? 'Document generated' : 'Document added', timelineSummaryText(d.displayName || d.name), d.uploadedBy || d.generatedBy || '', d.id, 'document', {
      name: d.displayName || d.name || '',
      type: d.type || '',
      mimeType: d.mimeType || '',
      source: d.source || '',
      clientVisible: Number(d.clientVisible || 0) === 1,
    });
  }
  for (const te of timeEntries) {
    const hours = Number(te.hours);
    const meta = { activity: te.activity || '', billable: Number(te.billable ?? 1) === 1 };
    if (Number.isFinite(hours)) meta.hours = hours;
    if (showMoney && te.rate !== null && te.rate !== undefined) meta.rate = Number(te.rate);
    push(te.date, 'time_entry', 'Time logged', timelineSummaryText([Number.isFinite(hours) ? `${hours.toFixed(1)}h` : '', te.activity].filter(Boolean).join(' · ')), te.attorney || '', te.id, 'time_entry', meta);
  }
  for (const inv of invoices) {
    const meta = { number: inv.number || '', status: inv.status || '', dueDate: inv.dueDate || '' };
    if (showMoney && inv.amount !== null && inv.amount !== undefined) meta.amount = Number(inv.amount);
    push(inv.date, 'invoice', 'Invoice issued', timelineSummaryText([inv.number, inv.status].filter(Boolean).join(' · ')), '', inv.id, 'invoice', meta);
  }
  for (const dl of deadlines) {
    push(dl.dueDate, 'deadline', 'Deadline', timelineSummaryText([dl.title, dl.status].filter(Boolean).join(' · ')), dl.owner || '', dl.id, 'deadline', { type: dl.type || '', status: dl.status || '' });
  }
  for (const p of payments) {
    const meta = { method: p.method || '', reference: p.reference || '' };
    if (showMoney && p.amount !== null && p.amount !== undefined) meta.amount = Number(p.amount);
    push(p.date || p.createdAt, 'payment', 'Payment recorded', timelineSummaryText([p.method, p.reference].filter(Boolean).join(' · ')), p.createdBy || '', p.id, 'payment', meta);
  }
  for (const c of checklist) {
    const status = c.completed ? 'completed' : 'open';
    push(c.completedAt || c.createdAt, 'checklist', c.completed ? 'Checklist item completed' : 'Checklist item added', timelineSummaryText(c.title), (c.completed ? c.completedBy : c.assignee) || '', c.id, 'matter_checklist_item', { status });
  }
  for (const s of stageHistory) {
    push(s.changedAt, 'stage_change', 'Stage changed', `${s.oldStage || '—'} → ${s.newStage}`, s.changedByName || '', s.id, 'matter_stage_history', { oldStage: s.oldStage || '', newStage: s.newStage || '', source: s.source || '' });
  }

  const parse = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
  return events
    .filter(e => parse(e.date) !== null)
    .sort((a, b) => {
      const at = parse(a.date), bt = parse(b.date);
      if (bt !== at) return bt - at;
      return `${a.sourceType}${a.sourceId}${a.title}`.localeCompare(`${b.sourceType}${b.sourceId}${b.title}`);
    });
}

app.get('/api/matters/:id/timeline', async (req, res) => {
  try {
    if (req.user.role === 'client') return res.status(403).json({ error: 'Staff access required' });
    const matter = await get('SELECT id FROM matters WHERE id=?', [req.params.id]);
    if (!matter) return res.status(404).json({ error: 'Matter not found' });
    if (!(await canAccessMatter(req, req.params.id))) {
      await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'matter_timeline' } }).catch(() => {});
      return res.status(403).json({ error: 'Matter access denied' });
    }
    const typeFilter = typeof req.query.type === 'string' && req.query.type ? req.query.type : '';
    if (typeFilter && !MATTER_TIMELINE_TYPES.has(typeFilter)) return res.status(400).json({ error: 'Invalid type filter' });
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = MATTER_TIMELINE_DEFAULT_LIMIT;
    if (limit > MATTER_TIMELINE_MAX_LIMIT) limit = MATTER_TIMELINE_MAX_LIMIT;

    const showMoney = await isBillingVisibleFor(req);
    let events = await buildMatterTimeline(req.params.id, { showMoney });
    if (typeFilter) events = events.filter(e => e.type === typeFilter);
    events = events.slice(0, limit);
    res.json({ matterId: req.params.id, count: events.length, events });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  // TIMELINE-30D: record the initial stage for newly created matters (prospective only; no backfill).
  await recordMatterStageChange(req, { matterId: id, oldStage: '', newStage: matter.stage || 'Intake', source: 'create' }).catch(() => {});
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
  // TIMELINE-30D: capture the prior stage before the update so a stage change can be recorded.
  let priorStage = null;
  if (updates.includes('stage')) {
    const before = await get('SELECT stage FROM matters WHERE id=?', [req.params.id]);
    priorStage = before ? before.stage : null;
  }
  await run(`UPDATE matters SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => ['billingRate','fixedFee','retainerBalance','totalBilled'].includes(f) ? Number(req.body[f] || 0) : req.body[f]), req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
  if (matter) {
    await logAudit(req, 'update', 'matter', req.params.id, `Updated matter ${matter.title}`);
    await recordAuditEvent(req, { action: 'matter_updated', entityType: 'matter', entityId: req.params.id, clientId: matter.clientId || '', metadata: { title: matter.title || '', updatedFields: updates.join(','), stage: matter.stage || '' } }).catch(() => {});
    if (updates.includes('stage')) {
      await recordMatterStageChange(req, { matterId: req.params.id, oldStage: priorStage, newStage: matter.stage || '', source: 'manual' }).catch(() => {});
    }
  }
  matter ? res.json(matter) : res.status(404).json({ error: 'Matter not found' });
});
app.patch('/api/matters/:id/status', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessMatter(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_matter_access', entityType: 'matter', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Matter access denied' });
  }
  // TIMELINE-30D: capture the prior stage before the status update.
  const beforeStatus = await get('SELECT stage FROM matters WHERE id=?', [req.params.id]);
  const priorStatusStage = beforeStatus ? beforeStatus.stage : null;
  await run('UPDATE matters SET stage=? WHERE id=?', [req.body.stage || 'Closed', req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
  if (matter) {
    await logAudit(req, 'archive', 'matter', req.params.id, `Set matter ${matter.title} stage to ${matter.stage}`);
    await recordAuditEvent(req, { action: 'matter_archived', entityType: 'matter', entityId: req.params.id, clientId: matter.clientId || '', metadata: { title: matter.title || '', stage: matter.stage || '' } }).catch(() => {});
    await recordMatterStageChange(req, { matterId: req.params.id, oldStage: priorStatusStage, newStage: matter.stage || '', source: 'status' }).catch(() => {});
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
  await run('DELETE FROM appearance_documents WHERE matterId=?', [matterId]);
  await run('DELETE FROM appearance_prep_items WHERE matterId=?', [matterId]);
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

const APPEARANCE_PREP_CATEGORIES = new Set(['general', 'document', 'witness', 'authority', 'submission', 'client', 'filing']);
const APPEARANCE_PREP_STATUSES = new Set(['open', 'done']);
function normalizeAppearancePrepCategory(value) {
  const category = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'general';
  return APPEARANCE_PREP_CATEGORIES.has(category) ? category : null;
}
function normalizeAppearancePrepStatus(value) {
  const status = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'open';
  return APPEARANCE_PREP_STATUSES.has(status) ? status : null;
}
function stripStaffAppearanceFields(appearance) {
  if (!appearance || typeof appearance !== 'object') return appearance;
  delete appearance.outcome;
  delete appearance.attendanceStatus;
  delete appearance.appearedBy;
  delete appearance.clientAttended;
  delete appearance.attendanceNote;
  delete appearance.attendanceUpdatedBy;
  delete appearance.attendanceUpdatedAt;
  delete appearance.prepItems;
  return appearance;
}
async function accessibleAppearanceForPrep(req, appearanceId) {
  if (!(await canAccessAppearance(req, appearanceId))) return null;
  return get('SELECT id, matterId FROM appearances WHERE id=?', [appearanceId]);
}
app.get('/api/appearances/:id/prep-items', requireStaff, async (req, res) => {
  const appearance = await accessibleAppearanceForPrep(req, req.params.id);
  if (!appearance) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_prep_item_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'appearance_prep_list' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  res.json(await all('SELECT * FROM appearance_prep_items WHERE appearanceId=? ORDER BY createdAt ASC', [req.params.id]));
});
app.post('/api/appearances/:id/prep-items', requireAdvocateOrAdmin, async (req, res) => {
  const appearance = await accessibleAppearanceForPrep(req, req.params.id);
  if (!appearance) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_prep_item_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'appearance_prep_create' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (title.length > 240) return res.status(400).json({ error: 'Title must not exceed 240 characters' });
  const category = normalizeAppearancePrepCategory(req.body?.category);
  if (!category) return res.status(400).json({ error: 'Invalid category' });
  const status = normalizeAppearancePrepStatus(req.body?.status);
  if (!status) return res.status(400).json({ error: 'Invalid status' });
  const id = genId('API');
  const now = new Date().toISOString();
  const actor = req.user.fullName || req.user.email || req.user.userId || '';
  await run('INSERT INTO appearance_prep_items (id,appearanceId,matterId,title,category,status,notes,createdBy,createdAt,updatedBy,updatedAt,completedBy,completedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    id, appearance.id, appearance.matterId, title, category, status, typeof req.body?.notes === 'string' ? req.body.notes : '', actor, now, '', '', status === 'done' ? actor : '', status === 'done' ? now : ''
  ]);
  res.json(await get('SELECT * FROM appearance_prep_items WHERE id=?', [id]));
});
app.patch('/api/appearance-prep-items/:id', requireAdvocateOrAdmin, async (req, res) => {
  const existing = await get('SELECT * FROM appearance_prep_items WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Prep item not found' });
  if (!(await canAccessAppearance(req, existing.appearanceId))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_prep_item_access', entityType: 'appearance_prep_item', entityId: req.params.id, matterId: existing.matterId || '', metadata: { reason: 'insufficient permissions', route: 'appearance_prep_update' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const updates = [];
  const params = [];
  if (req.body?.title !== undefined) {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'Title must not be empty' });
    if (title.length > 240) return res.status(400).json({ error: 'Title must not exceed 240 characters' });
    updates.push('title=?'); params.push(title);
  }
  if (req.body?.category !== undefined) {
    const category = normalizeAppearancePrepCategory(req.body.category);
    if (!category) return res.status(400).json({ error: 'Invalid category' });
    updates.push('category=?'); params.push(category);
  }
  if (req.body?.notes !== undefined) {
    updates.push('notes=?'); params.push(typeof req.body.notes === 'string' ? req.body.notes : '');
  }
  if (req.body?.status !== undefined) {
    const status = normalizeAppearancePrepStatus(req.body.status);
    if (!status) return res.status(400).json({ error: 'Invalid status' });
    updates.push('status=?'); params.push(status);
    if (status === 'done' && existing.status !== 'done') {
      updates.push('completedBy=?', 'completedAt=?');
      params.push(req.user.fullName || req.user.email || req.user.userId || '', new Date().toISOString());
    } else if (status === 'open') {
      updates.push('completedBy=?', 'completedAt=?');
      params.push('', '');
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  updates.push('updatedBy=?', 'updatedAt=?');
  params.push(req.user.fullName || req.user.email || req.user.userId || '', new Date().toISOString(), req.params.id);
  await run(`UPDATE appearance_prep_items SET ${updates.join(',')} WHERE id=?`, params);
  res.json(await get('SELECT * FROM appearance_prep_items WHERE id=?', [req.params.id]));
});
app.delete('/api/appearance-prep-items/:id', requireAdvocateOrAdmin, async (req, res) => {
  const existing = await get('SELECT * FROM appearance_prep_items WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Prep item not found' });
  if (!(await canAccessAppearance(req, existing.appearanceId))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_prep_item_access', entityType: 'appearance_prep_item', entityId: req.params.id, matterId: existing.matterId || '', metadata: { reason: 'insufficient permissions', route: 'appearance_prep_delete' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const now = new Date().toISOString();
  const actor = req.user.fullName || req.user.email || req.user.userId || '';
  await run('UPDATE appearance_prep_items SET status=?, completedBy=?, completedAt=?, updatedBy=?, updatedAt=? WHERE id=?', ['done', actor, now, actor, now, req.params.id]);
  res.json({ id: req.params.id, deleted: false, status: 'done' });
});

// KENYA-34B: staff-only links between matter documents and specific appearances.
// The join NEVER changes document visibility, the client portal, or the download path.
function publicAppearanceDocumentLink(row = {}) {
  return {
    id: row.id,
    appearanceId: row.appearanceId,
    documentId: row.documentId,
    matterId: row.matterId,
    label: row.label || '',
    createdBy: row.createdBy || '',
    createdAt: row.createdAt || '',
    document: {
      id: row.documentId,
      displayName: row.displayName || row.docName || 'Document',
      name: row.docName || '',
      type: row.docType || '',
      date: row.docDate || '',
    },
  };
}
app.get('/api/appearances/:id/documents', requireStaff, async (req, res) => {
  const appearance = await accessibleAppearanceForPrep(req, req.params.id);
  if (!appearance) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_document_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'appearance_document_list' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const rows = await all(`SELECT ad.id, ad.appearanceId, ad.documentId, ad.matterId, ad.label, ad.createdBy, ad.createdAt,
      d.displayName, d.name docName, d.type docType, d.date docDate
    FROM appearance_documents ad JOIN documents d ON d.id=ad.documentId
    WHERE ad.appearanceId=? AND d.deletedAt IS NULL ORDER BY ad.createdAt ASC`, [req.params.id]);
  res.json(rows.map(publicAppearanceDocumentLink));
});
app.post('/api/appearances/:id/documents', requireAdvocateOrAdmin, async (req, res) => {
  const appearance = await accessibleAppearanceForPrep(req, req.params.id);
  if (!appearance) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_document_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions', route: 'appearance_document_link' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const documentId = typeof req.body?.documentId === 'string' ? req.body.documentId.trim() : '';
  if (!documentId) return res.status(400).json({ error: 'documentId is required' });
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 240) : '';
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : '';
  const doc = await get('SELECT * FROM documents WHERE id=? AND deletedAt IS NULL', [documentId]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.matterId !== appearance.matterId) return res.status(400).json({ error: 'Document belongs to a different matter' });
  if (!(await canAccessMatter(req, appearance.matterId)) || !(await canAccessDocument(req, doc))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_document_access', entityType: 'document', entityId: documentId, matterId: appearance.matterId, metadata: { reason: 'insufficient permissions', route: 'appearance_document_link' } }).catch(() => {});
    return res.status(403).json({ error: 'Document access denied' });
  }
  const existing = await get('SELECT * FROM appearance_documents WHERE appearanceId=? AND documentId=?', [req.params.id, documentId]);
  if (existing) {
    const row = await get(`SELECT ad.id, ad.appearanceId, ad.documentId, ad.matterId, ad.label, ad.createdBy, ad.createdAt,
        d.displayName, d.name docName, d.type docType, d.date docDate
      FROM appearance_documents ad JOIN documents d ON d.id=ad.documentId WHERE ad.id=?`, [existing.id]);
    return res.json(publicAppearanceDocumentLink(row));
  }
  const id = genId('ADL');
  const now = new Date().toISOString();
  const actor = req.user.fullName || req.user.email || req.user.userId || '';
  await run('INSERT INTO appearance_documents (id,appearanceId,documentId,matterId,label,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?)', [id, req.params.id, documentId, appearance.matterId, label, notes, actor, now]);
  await recordAuditEvent(req, { action: 'appearance_document_linked', entityType: 'appearance_document', entityId: id, matterId: appearance.matterId, metadata: { appearanceId: req.params.id, documentId, matterId: appearance.matterId, label } }).catch(() => {});
  const row = await get(`SELECT ad.id, ad.appearanceId, ad.documentId, ad.matterId, ad.label, ad.createdBy, ad.createdAt,
      d.displayName, d.name docName, d.type docType, d.date docDate
    FROM appearance_documents ad JOIN documents d ON d.id=ad.documentId WHERE ad.id=?`, [id]);
  res.json(publicAppearanceDocumentLink(row));
});
app.delete('/api/appearance-documents/:id', requireAdvocateOrAdmin, async (req, res) => {
  const link = await get('SELECT * FROM appearance_documents WHERE id=?', [req.params.id]);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  if (!(await canAccessAppearance(req, link.appearanceId))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_document_access', entityType: 'appearance_document', entityId: req.params.id, matterId: link.matterId || '', metadata: { reason: 'insufficient permissions', route: 'appearance_document_unlink' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  await run('DELETE FROM appearance_documents WHERE id=?', [req.params.id]);
  await recordAuditEvent(req, { action: 'appearance_document_unlinked', entityType: 'appearance_document', entityId: req.params.id, matterId: link.matterId || '', metadata: { appearanceId: link.appearanceId, documentId: link.documentId, matterId: link.matterId || '', label: link.label || '' } }).catch(() => {});
  res.json({ id: req.params.id, unlinked: true });
});

const APPEARANCE_ATTENDANCE_STATUSES = new Set(['scheduled', 'attended', 'adjourned', 'stood_over', 'heard', 'not_attended', 'cancelled']);
function normalizeAppearanceAttendanceStatus(value) {
  const status = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'scheduled';
  return APPEARANCE_ATTENDANCE_STATUSES.has(status) ? status : null;
}
app.post('/api/appearances', requireAdvocateOrAdmin, async (req, res) => { const id = genId('EV'); await run('INSERT INTO appearances (id,matterId,title,date,time,type,location,meetingLink,attorney,prepNote,outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.title, req.body.date, req.body.time || '9:00 AM', req.body.type || 'Hearing', req.body.location || '', req.body.meetingLink || '', req.body.attorney || '', req.body.prepNote || '', req.body.outcome || '']); const event = await get('SELECT * FROM appearances WHERE id=?', [id]); await logAudit(req, 'create', 'appearance', id, `Scheduled ${event.type || 'appearance'} ${event.title || ''} on ${event.date}`); res.json(event); });
app.patch('/api/appearances/:id', requireAdvocateOrAdmin, async (req, res) => {
  if (!(await canAccessAppearance(req, req.params.id))) {
    await recordAuditEvent(req, { action: 'forbidden_appearance_access', entityType: 'appearance', entityId: req.params.id, metadata: { reason: 'insufficient permissions' } }).catch(() => {});
    return res.status(403).json({ error: 'Appearance access denied' });
  }
  const fields = ['matterId','title','date','time','type','location','meetingLink','attorney','prepNote','outcome','attendanceStatus','appearedBy','clientAttended','attendanceNote'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  if (req.body.attendanceStatus !== undefined && !normalizeAppearanceAttendanceStatus(req.body.attendanceStatus)) return res.status(400).json({ error: 'Invalid attendanceStatus' });
  const attendanceFields = ['attendanceStatus', 'appearedBy', 'clientAttended', 'attendanceNote'];
  const attendanceUpdated = attendanceFields.some(f => req.body[f] !== undefined);
  const setFields = [...updates];
  const params = updates.map(f => {
    if (f === 'attendanceStatus') return normalizeAppearanceAttendanceStatus(req.body[f]);
    if (f === 'clientAttended') return req.body[f] ? 1 : 0;
    return req.body[f];
  });
  if (attendanceUpdated) {
    setFields.push('attendanceUpdatedBy', 'attendanceUpdatedAt');
    params.push(req.user.fullName || req.user.email || req.user.userId || '', new Date().toISOString());
  }
  await run(`UPDATE appearances SET ${setFields.map(f => `${f}=?`).join(',')} WHERE id=?`, [...params, req.params.id]);
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
  await run('DELETE FROM appearance_documents WHERE appearanceId=?', [req.params.id]);
  await run('DELETE FROM appearance_prep_items WHERE appearanceId=?', [req.params.id]);
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
    // LOCAL-PILOT-FIX-2: optional manual invoice — a stated amount for matters
    // without unbilled time or a fixed fee. Same access and billing-visibility
    // checks and the same response shape as generated invoices; time entries
    // are never touched by this branch.
    if (req.body.manual === true) {
      const manualAmount = Number(req.body.amount);
      if (!Number.isFinite(manualAmount) || manualAmount <= 0) return res.status(400).json({ error: 'amount must be a positive number for a manual invoice' });
      if (manualAmount > 1000000000) return res.status(400).json({ error: 'amount is too large' });
      amount = Math.round(manualAmount * 100) / 100;
      source = 'manual';
      items = [{ description: String(req.body.description || 'Legal services').slice(0, 500), hours: 0, rate: 0, amount }];
    } else if (matter.billingType === 'fixed') {
      amount = Number(matter.fixedFee || 0);
      source = 'fixed';
      items = [{ description: 'Legal Services (Fixed Fee)', hours: 0, rate: 0, amount }];
    } else {
      const entries = await all('SELECT * FROM time_entries WHERE matterId=? AND billed=0 AND billable=1', [matter.id]);
      items = entries.map(t => ({ timeEntryId: t.id, date: t.date, description: t.description || t.activity || 'Legal Services', hours: Number(t.hours || 0), rate: Number(t.rate || 0), amount: Number(t.hours || 0) * Number(t.rate || 0) }));
      amount = items.reduce((sum, item) => sum + item.amount, 0);
    }
    if (amount <= 0) return res.status(400).json({ error: 'No billable amount found for this matter' });
    await run('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, matter.id, matter.clientId, number, date, amount, 'Outstanding', dueDate, source === 'fixed' ? 'Fixed fee invoice' : source === 'manual' ? 'Manual invoice' : 'Unbilled time invoice', source]);
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
  if (data.appearances) {
    data.appearances.forEach(stripStaffAppearanceFields);
  }
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
app.post('/api/whatsapp/reminders', requireStaff, async (req, res) => { const rows = await all(`SELECT a.matterId,a.title,a.date,a.time,m.clientId,m.title matterTitle,c.name clientName,c.phone FROM appearances a LEFT JOIN matters m ON m.id=a.matterId LEFT JOIN clients c ON c.id=m.clientId WHERE a.date BETWEEN ? AND ?`, [today(), addDays(Number(req.body.days || 3))]); const reminders = rows.map(r => ({ id: genId('WA'), matterId: r.matterId, clientName: r.clientName, phone: r.phone, message: `Reminder: ${r.title} for ${r.matterTitle} is on ${r.date} at ${r.time || 'TBA'}.`, status: r.phone ? 'Queued' : 'Missing phone' })); res.json({ count: reminders.length, reminders }); });
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

module.exports = { app, config, dbReady, repairClientUserLinks };

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
