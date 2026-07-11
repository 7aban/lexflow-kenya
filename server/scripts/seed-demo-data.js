const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { hashPassword } = require('../lib/passwords');
const config = require('../lib/config');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const dbPath = config.DATABASE_PATH;
const db = new sqlite3.Database(dbPath);

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function onRun(err) { err ? reject(err) : resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));

const today = new Date();
const iso = date => date.toISOString().slice(0, 10);
const daysAgo = days => iso(new Date(today.getTime() - days * 86400000));
const daysFromNow = days => iso(new Date(today.getTime() + days * 86400000));
const nowIso = () => new Date().toISOString();
const id = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const pick = (items, index) => items[index % items.length];
const moneyRef = index => `QK${String(746200 + index).padStart(8, '0')}`;

const defaultReminderTemplates = [
  ['court_date_tomorrow', 'whatsapp', '', 'Good evening {{clientName}}. This is a reminder from {{firmName}} that {{matterTitle}} is listed tomorrow, {{courtDate}}, at {{courtTime}}.'],
  ['court_date_tomorrow', 'email', 'Court reminder for {{matterTitle}}', 'Dear {{clientName}},\n\nThis is a reminder that {{matterTitle}} is listed tomorrow, {{courtDate}}, at {{courtTime}}.\n\n{{firmName}}'],
  ['court_date_today', 'whatsapp', '', 'Good morning {{clientName}}. {{matterTitle}} is listed today at {{courtTime}}. {{firmName}} will keep you updated.'],
  ['court_date_today', 'email', 'Court today: {{matterTitle}}', 'Dear {{clientName}},\n\nThis is a reminder that {{matterTitle}} is listed today, {{courtDate}}, at {{courtTime}}.'],
  ['invoice_overdue', 'whatsapp', '', 'Dear {{clientName}}, invoice for {{matterTitle}} amounting to {{invoiceAmount}} is overdue. Kindly contact {{firmName}}.'],
  ['invoice_overdue', 'email', 'Overdue invoice for {{matterTitle}}', 'Dear {{clientName}},\n\nOur records show an overdue invoice of {{invoiceAmount}} for {{matterTitle}}.'],
  ['invoice_outstanding', 'whatsapp', '', 'Dear {{clientName}}, this is a gentle reminder that invoice {{invoiceAmount}} for {{matterTitle}} is due on {{invoiceDueDate}}.'],
  ['invoice_outstanding', 'email', 'Invoice reminder for {{matterTitle}}', 'Dear {{clientName}},\n\nThis is a gentle reminder that invoice {{invoiceAmount}} is due on {{invoiceDueDate}}.'],
];

async function createSchema() {
  const tables = [
    'work_metadata_matter_links', 'work_email_messages', 'work_calendar_events', 'connected_account_sync_state', 'connected_account_tokens', 'connected_accounts',
    'audit_logs', 'notifications', 'payment_proofs', 'payments', 'receipt_sequences', 'expenses', 'disbursements', 'invoice_items', 'invoices',
     'messages', 'conversations', 'client_activity', 'case_notes', 'documents', 'signature_assets', 'folders', 'appearances', 'time_entries', 'tasks', 'deadlines', 'document_templates', 'checklist_template_items', 'checklist_templates', 'matter_checklist_items', 'document_requests', 'matters', 'clients',
    'users', 'integrations_log', 'firm_settings', 'reminder_settings', 'reminder_templates', 'reminder_logs',
    'firm_notices', 'invitations',
  ];
  await run('PRAGMA foreign_keys=OFF');
  for (const table of tables) await run(`DROP TABLE IF EXISTS ${table}`);

  await run(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin','client')) DEFAULT 'assistant', clientId TEXT, createdAt TEXT, tokenVersion INTEGER DEFAULT 1, isActive INTEGER DEFAULT 1)`);
  await run(`CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'Individual', contact TEXT, email TEXT, phone TEXT, status TEXT DEFAULT 'Active', joinDate TEXT, conflictCleared INTEGER DEFAULT 0, retainer REAL DEFAULT 0, remindersEnabled INTEGER DEFAULT 1, preferredChannel TEXT DEFAULT 'firm_default')`);
  await run(`CREATE TABLE matters (id TEXT PRIMARY KEY, reference TEXT UNIQUE, clientId TEXT NOT NULL, title TEXT NOT NULL, practiceArea TEXT, stage TEXT DEFAULT 'Intake', assignedTo TEXT, paralegal TEXT, openDate TEXT, description TEXT, court TEXT, judge TEXT, caseNo TEXT, opposingCounsel TEXT, billingRate REAL DEFAULT 0, retainerBalance REAL DEFAULT 0, totalBilled REAL DEFAULT 0, priority TEXT DEFAULT 'Medium', solDate TEXT, billingType TEXT DEFAULT 'hourly', fixedFee REAL DEFAULT 0, remindersEnabled TEXT DEFAULT 'firm_default', courtRemindersEnabled TEXT DEFAULT 'firm_default', invoiceRemindersEnabled TEXT DEFAULT 'firm_default')`);
  await run(`CREATE TABLE matter_checklist_items (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, position INTEGER DEFAULT 0, notes TEXT, createdBy TEXT, createdAt TEXT NOT NULL, completedAt TEXT, completedBy TEXT)`);
  await run(`CREATE TABLE checklist_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, practiceArea TEXT, active INTEGER DEFAULT 1, createdBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE checklist_template_items (id TEXT PRIMARY KEY, templateId TEXT NOT NULL, title TEXT NOT NULL, notes TEXT, position INTEGER DEFAULT 0, createdAt TEXT NOT NULL)`);
  await run(`CREATE TABLE document_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, practiceArea TEXT, category TEXT, bodyMarkup TEXT, active INTEGER DEFAULT 1, createdBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE document_requests (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT NOT NULL, staffUserId TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'pending', createdAt TEXT NOT NULL, respondedAt TEXT, responseDocumentId TEXT, cancelledAt TEXT, cancelledBy TEXT)`);
  await run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, assignee TEXT, dueDate TEXT, auto_generated INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE time_entries (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, taskId TEXT, attorney TEXT, date TEXT, hours REAL DEFAULT 0, activity TEXT, description TEXT, rate REAL DEFAULT 0, billed INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE appearances (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT, date TEXT, time TEXT, type TEXT, location TEXT, meetingLink TEXT, attorney TEXT, prepNote TEXT)`);
  await run(`CREATE TABLE folders (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT NOT NULL, createdBy TEXT, createdAt TEXT, archivedAt TEXT)`);
  await run(`CREATE TABLE documents (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT, displayName TEXT, type TEXT, mimeType TEXT, date TEXT, size TEXT, content BLOB, source TEXT DEFAULT 'firm', folderId TEXT, messageId TEXT, noticeId TEXT, clientVisible INTEGER DEFAULT 0, uploadedBy TEXT, deletedAt TEXT, templateId TEXT, templateName TEXT, generatedBy TEXT, generatedAt TEXT, version INTEGER DEFAULT 1)`);
  await run(`CREATE TABLE case_notes (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, content TEXT NOT NULL, author TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE invoices (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT, number TEXT, date TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'Outstanding', dueDate TEXT, description TEXT, source TEXT DEFAULT 'time')`);
  await run(`CREATE TABLE invoice_items (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, timeEntryId TEXT, date TEXT, description TEXT, hours REAL DEFAULT 0, rate REAL DEFAULT 0, amount REAL DEFAULT 0)`);
  await run(`CREATE TABLE payments (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, matterId TEXT NOT NULL, clientId TEXT NOT NULL, amount REAL NOT NULL, method TEXT, reference TEXT, date TEXT NOT NULL, note TEXT, proofId TEXT, createdBy TEXT, createdAt TEXT NOT NULL, receiptNumber TEXT, receiptIssuedAt TEXT, voidedAt TEXT, voidedBy TEXT, voidReason TEXT)`);
  await run(`CREATE TABLE receipt_sequences (year TEXT PRIMARY KEY, lastSeq INTEGER NOT NULL DEFAULT 0)`);
  await run(`CREATE TABLE disbursements (id TEXT PRIMARY KEY, matterId TEXT, invoiceId TEXT, description TEXT, amount REAL DEFAULT 0, date TEXT, billed INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE expenses (id TEXT PRIMARY KEY, matterId TEXT, category TEXT, description TEXT, amount REAL DEFAULT 0, date TEXT, vendor TEXT)`);
  await run(`CREATE TABLE integrations_log (id TEXT PRIMARY KEY, type TEXT NOT NULL, matterId TEXT, clientId TEXT, recipient TEXT, message TEXT, status TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE firm_settings (id TEXT PRIMARY KEY, name TEXT, logo TEXT, primaryColor TEXT, accentColor TEXT, websiteURL TEXT, email TEXT, phone TEXT, address TEXT, themeJson TEXT)`);
  await run(`CREATE TABLE reminder_settings (id TEXT PRIMARY KEY, remindersEnabled INTEGER DEFAULT 1, whatsappEnabled INTEGER DEFAULT 0, emailEnabled INTEGER DEFAULT 0, twilioSid TEXT, twilioToken TEXT, twilioFromNumber TEXT, smtpHost TEXT, smtpPort TEXT, smtpUser TEXT, smtpPass TEXT)`);
  await run(`CREATE TABLE reminder_templates (id TEXT PRIMARY KEY, eventType TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE reminder_logs (id TEXT PRIMARY KEY, templateId TEXT, clientId TEXT, matterId TEXT, invoiceId TEXT, channel TEXT, recipient TEXT, status TEXT, sentAt TEXT, errorMessage TEXT)`);
  await run(`CREATE TABLE firm_notices (id TEXT PRIMARY KEY, title TEXT, content TEXT, createdAt TEXT, createdBy TEXT, clientId TEXT DEFAULT '')`);
  await run(`CREATE TABLE conversations (id TEXT PRIMARY KEY, matterId TEXT, clientId TEXT NOT NULL, subject TEXT, createdAt TEXT, status TEXT DEFAULT 'open', lastStaffReadAt TEXT, lastClientReadAt TEXT, statusUpdatedAt TEXT)`);
  await run(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT, senderRole TEXT, body TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE client_activity (id TEXT PRIMARY KEY, clientId TEXT, matterId TEXT, userId TEXT, action TEXT, summary TEXT, entityType TEXT, entityId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE deadlines (id TEXT PRIMARY KEY, matterId TEXT, clientId TEXT, title TEXT NOT NULL, type TEXT DEFAULT 'internal', dueDate TEXT NOT NULL, owner TEXT, status TEXT DEFAULT 'Open', notes TEXT, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE payment_proofs (id TEXT PRIMARY KEY, invoiceId TEXT, matterId TEXT, clientId TEXT, method TEXT, reference TEXT, amount REAL DEFAULT 0, note TEXT, fileName TEXT, mimeType TEXT, size TEXT, content BLOB, createdAt TEXT, status TEXT DEFAULT 'Pending', reviewedBy TEXT, reviewedAt TEXT, reviewNote TEXT, paymentId TEXT)`);
  await run(`CREATE TABLE invitations (id TEXT PRIMARY KEY, email TEXT NOT NULL, clientId TEXT, token TEXT UNIQUE NOT NULL, status TEXT DEFAULT 'pending', createdBy TEXT, createdAt TEXT, expiresAt TEXT)`);
  await run(`CREATE TABLE audit_logs (id TEXT PRIMARY KEY, userId TEXT, userName TEXT, role TEXT, action TEXT, entityType TEXT, entityId TEXT, summary TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE notifications (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT, matterId TEXT, clientId TEXT, title TEXT, body TEXT, createdAt TEXT, readAt TEXT)`);
  await run(`CREATE TABLE connected_accounts (id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')), providerAccountId TEXT, email TEXT, displayName TEXT, scopes TEXT, status TEXT NOT NULL DEFAULT 'connected', connectedAt TEXT NOT NULL, disconnectedAt TEXT, lastSyncAt TEXT, lastError TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE connected_account_tokens (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, accessTokenEncrypted TEXT, refreshTokenEncrypted TEXT, tokenType TEXT, expiresAt TEXT, scope TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
  await run(`CREATE TABLE work_email_messages (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, userId TEXT NOT NULL, provider TEXT NOT NULL, providerAccountId TEXT, providerMessageId TEXT NOT NULL, providerThreadId TEXT, sender TEXT, recipientsSummary TEXT, subject TEXT, snippet TEXT, receivedAt TEXT, hasAttachments INTEGER DEFAULT 0, labelsJson TEXT, foldersJson TEXT, matchedMatterId TEXT, matchConfidence REAL, matchReason TEXT, importedAt TEXT NOT NULL, updatedAt TEXT, UNIQUE(connectedAccountId, providerMessageId))`);
  await run(`CREATE TABLE connected_account_sync_state (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, syncType TEXT NOT NULL, cursorJson TEXT, lastAttemptAt TEXT, lastSuccessAt TEXT, lastError TEXT, lastImportedCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT, UNIQUE(connectedAccountId, syncType))`);
  await run(`CREATE TABLE work_calendar_events (id TEXT PRIMARY KEY, connectedAccountId TEXT NOT NULL, userId TEXT NOT NULL, provider TEXT NOT NULL, providerAccountId TEXT, providerEventId TEXT NOT NULL, calendarId TEXT, calendarName TEXT, subject TEXT, startTime TEXT, endTime TEXT, location TEXT, meetingLink TEXT, organizer TEXT, attendeesSummary TEXT, descriptionSnippet TEXT, providerUpdatedAt TEXT, matchedMatterId TEXT, matchConfidence REAL, matchReason TEXT, importedAt TEXT NOT NULL, updatedAt TEXT, UNIQUE(connectedAccountId, providerEventId))`);
  await run(`CREATE TABLE work_metadata_matter_links (id TEXT PRIMARY KEY, sourceType TEXT NOT NULL, sourceId TEXT NOT NULL, matterId TEXT NOT NULL, suggestedMatterId TEXT, confidence REAL, reason TEXT, status TEXT NOT NULL, confirmedBy TEXT, confirmedAt TEXT, unlinkedBy TEXT, unlinkedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT)`);
}

async function insertAudit(action, entityType, entityId, summary, userName = 'Demo Seeder', role = 'admin') {
  await run('INSERT INTO audit_logs (id,userId,userName,role,action,entityType,entityId,summary,createdAt) VALUES (?,?,?,?,?,?,?,?,?)', [id('AUD'), 'seed-admin', userName, role, action, entityType, entityId, summary, nowIso()]);
}

async function seededPdfBuffer(label) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 400]);
  page.drawText(String(label || 'Seeded Demo PDF'), { x: 24, y: 200, size: 14, font });
  return Buffer.from(await pdf.save());
}

// DEMO-27G: build a valid tiny RGB PNG (zlib + CRC32, no external packages) so
// seeded image documents can actually be embedded by the Images-to-PDF tool.
function seededPngBuffer(seed = 0) {
  const zlib = require('zlib');
  const crc32 = (buf) => {
    let crc = ~0;
    for (let i = 0; i < buf.length; i += 1) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const width = 4;
  const height = 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // compression / filter / interlace
  const rowLen = width * 3;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * (rowLen + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = off + 1 + x * 3;
      raw[p] = (seed * 37 + x * 20) & 0xff;
      raw[p + 1] = (seed * 53 + y * 20) & 0xff;
      raw[p + 2] = 128;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function seedIntegrationMetadata({ admin, matters }) {
  const matterByReference = new Map(matters.map(matter => [matter.reference, matter]));
  const requireMatter = reference => {
    const matter = matterByReference.get(reference);
    if (!matter) throw new Error(`Demo integration metadata matter ${reference} was not seeded`);
    return matter;
  };
  const stamp = minutesAgo => new Date(today.getTime() - minutesAgo * 60000).toISOString();
  const futureStamp = daysFromNowValue => new Date(today.getTime() + daysFromNowValue * 86400000).toISOString();
  const googleScopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.metadata',
    'https://www.googleapis.com/auth/calendar.readonly',
  ].join(' ');
  const microsoftScopes = 'openid email profile offline_access User.Read Mail.ReadBasic Calendars.ReadBasic';
  const accounts = [
    {
      id: 'demo-connected-account-google-metadata',
      provider: 'google',
      providerAccountId: 'demo-google-metadata-seed',
      email: 'demo-google-metadata@example.test',
      displayName: 'Demo Google Workspace',
      scopes: googleScopes,
      connectedAt: stamp(180),
    },
    {
      id: 'demo-connected-account-microsoft-metadata',
      provider: 'microsoft',
      providerAccountId: 'demo-microsoft-metadata-seed',
      email: 'demo-microsoft-metadata@example.test',
      displayName: 'Demo Microsoft 365',
      scopes: microsoftScopes,
      connectedAt: stamp(170),
    },
  ];

  for (const account of accounts) {
    await run(
      `INSERT INTO connected_accounts
       (id,userId,provider,providerAccountId,email,displayName,scopes,status,connectedAt,disconnectedAt,lastSyncAt,lastError,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [account.id, admin.id, account.provider, account.providerAccountId, account.email, account.displayName, account.scopes, 'connected', account.connectedAt, null, null, '', account.connectedAt, account.connectedAt],
    );
  }

  const estateMatter = requireMatter('LEX-2026-0001');
  const fleetMatter = requireMatter('LEX-2026-0002');
  const debtMatter = requireMatter('LEX-2026-0003');
  const housingMatter = requireMatter('LEX-2026-0005');
  const medicalMatter = requireMatter('LEX-2026-0007');
  const googleAccount = accounts[0];
  const microsoftAccount = accounts[1];

  const emailRows = [
    {
      id: 'demo-work-email-lex-2026-0001-confirmed',
      account: googleAccount,
      providerMessageId: 'demo-email-confirmed-lex-2026-0001',
      providerThreadId: 'demo-thread-lex-2026-0001',
      sender: 'probate.registry@example.test',
      recipientsSummary: 'demo-google-metadata@example.test; sarah.mwangi@achokilaw.co.ke',
      subject: 'LEX-2026-0001 registry update for Estate Administration',
      snippet: 'Metadata-only registry update references LEX-2026-0001 and the estate administration status.',
      receivedAt: stamp(18),
      hasAttachments: 1,
      labelsJson: JSON.stringify(['INBOX', 'IMPORTANT', 'DEMO_METADATA']),
      foldersJson: JSON.stringify(['Inbox']),
      matter: estateMatter,
      matchConfidence: 0.95,
      matchReason: 'Reference match: LEX-2026-0001',
    },
    {
      id: 'demo-work-email-lex-2026-0002-suggested',
      account: microsoftAccount,
      providerMessageId: 'demo-email-suggested-lex-2026-0002',
      providerThreadId: 'demo-thread-lex-2026-0002',
      sender: 'legal@kamaulogistics.co.ke',
      recipientsSummary: 'demo-microsoft-metadata@example.test; sarah.mwangi@achokilaw.co.ke',
      subject: 'Fleet leasing contract review follow-up',
      snippet: 'Kamau Logistics asks for comments on the Fleet Leasing Contract Review engagement.',
      receivedAt: stamp(42),
      hasAttachments: 0,
      labelsJson: JSON.stringify(['INBOX', 'DEMO_METADATA']),
      foldersJson: JSON.stringify(['Inbox']),
      matter: fleetMatter,
      matchConfidence: 0.74,
      matchReason: 'Client email domain match: kamaulogistics.co.ke',
    },
    {
      id: 'demo-work-email-lex-2026-0003-suggested',
      account: googleAccount,
      providerMessageId: 'demo-email-suggested-lex-2026-0003',
      providerThreadId: 'demo-thread-lex-2026-0003',
      sender: 'clerk.milimani@example.test',
      recipientsSummary: 'demo-google-metadata@example.test; michael.oduor@achokilaw.co.ke',
      subject: 'Mention date query MCCC/E401/2025',
      snippet: 'Metadata-only registry note references MCCC/E401/2025 for the debt recovery matter.',
      receivedAt: stamp(75),
      hasAttachments: 0,
      labelsJson: JSON.stringify(['INBOX', 'COURT', 'DEMO_METADATA']),
      foldersJson: JSON.stringify(['Inbox']),
      matter: debtMatter,
      matchConfidence: 0.92,
      matchReason: 'Case number match: MCCC/E401/2025',
    },
    {
      id: 'demo-work-email-unmatched-admin-bulletin',
      account: microsoftAccount,
      providerMessageId: 'demo-email-unmatched-admin-bulletin',
      providerThreadId: 'demo-thread-admin-bulletin',
      sender: 'training@example.test',
      recipientsSummary: 'demo-microsoft-metadata@example.test',
      subject: 'CLE bulletin - June practice management',
      snippet: 'General CPD newsletter and office administration update.',
      receivedAt: stamp(130),
      hasAttachments: 0,
      labelsJson: JSON.stringify(['INBOX', 'NEWSLETTER', 'DEMO_METADATA']),
      foldersJson: JSON.stringify(['Inbox']),
      matter: null,
      matchConfidence: null,
      matchReason: null,
    },
  ];

  for (const message of emailRows) {
    await run(
      `INSERT INTO work_email_messages
       (id,connectedAccountId,userId,provider,providerAccountId,providerMessageId,providerThreadId,sender,recipientsSummary,subject,snippet,receivedAt,hasAttachments,labelsJson,foldersJson,matchedMatterId,matchConfidence,matchReason,importedAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        message.id,
        message.account.id,
        admin.id,
        message.account.provider,
        message.account.providerAccountId,
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
        message.matter?.id || null,
        message.matchConfidence,
        message.matchReason,
        message.receivedAt,
        message.receivedAt,
      ],
    );
  }

  const calendarRows = [
    {
      id: 'demo-work-calendar-lex-2026-0005-confirmed',
      account: microsoftAccount,
      providerEventId: 'demo-calendar-confirmed-lex-2026-0005',
      calendarId: 'primary',
      calendarName: 'Demo Work Calendar',
      subject: 'CHRPET/E045/2025 procurement review conference',
      startTime: futureStamp(1),
      endTime: futureStamp(1 + (90 / 1440)),
      location: 'Milimani Constitutional and Human Rights Division',
      meetingLink: 'https://meet.example.test/lexflow-demo-housing-review',
      organizer: 'demo-microsoft-metadata@example.test',
      attendeesSummary: 'sarah.mwangi@achokilaw.co.ke; procurement.secretariat@example.test',
      descriptionSnippet: 'Metadata-only preview for procurement review coordination.',
      providerUpdatedAt: stamp(26),
      matter: housingMatter,
      matchConfidence: 0.92,
      matchReason: 'Case number match: CHRPET/E045/2025',
    },
    {
      id: 'demo-work-calendar-lex-2026-0007-suggested',
      account: googleAccount,
      providerEventId: 'demo-calendar-suggested-lex-2026-0007',
      calendarId: 'primary',
      calendarName: 'Demo Work Calendar',
      subject: 'HCCC/E771/2025 medical negligence defence strategy check-in',
      startTime: futureStamp(2),
      endTime: futureStamp(2 + (60 / 1440)),
      location: 'Boardroom 2',
      meetingLink: '',
      organizer: 'achieng.otieno@achokilaw.co.ke',
      attendeesSummary: 'demo-google-metadata@example.test; admin@lakeviewmedical.co.ke',
      descriptionSnippet: 'Metadata-only preview for strategy coordination.',
      providerUpdatedAt: stamp(34),
      matter: medicalMatter,
      matchConfidence: 0.92,
      matchReason: 'Case number match: HCCC/E771/2025',
    },
    {
      id: 'demo-work-calendar-lex-2026-0001-suggested',
      account: googleAccount,
      providerEventId: 'demo-calendar-suggested-lex-2026-0001',
      calendarId: 'primary',
      calendarName: 'Demo Work Calendar',
      subject: 'LEX-2026-0001 probate registry planning',
      startTime: futureStamp(3),
      endTime: futureStamp(3 + (45 / 1440)),
      location: 'High Court Family Division registry',
      meetingLink: '',
      organizer: 'sarah.mwangi@achokilaw.co.ke',
      attendeesSummary: 'demo-google-metadata@example.test; probate.registry@example.test',
      descriptionSnippet: 'Metadata-only preview for estate administration planning.',
      providerUpdatedAt: stamp(48),
      matter: estateMatter,
      matchConfidence: 0.95,
      matchReason: 'Reference match: LEX-2026-0001',
    },
    {
      id: 'demo-work-calendar-unmatched-weekly-ops',
      account: microsoftAccount,
      providerEventId: 'demo-calendar-unmatched-weekly-ops',
      calendarId: 'primary',
      calendarName: 'Demo Work Calendar',
      subject: 'Weekly operations and admin meeting',
      startTime: futureStamp(4),
      endTime: futureStamp(4 + (30 / 1440)),
      location: 'Nairobi office',
      meetingLink: 'https://meet.example.test/lexflow-demo-ops',
      organizer: 'operations@example.test',
      attendeesSummary: 'demo-microsoft-metadata@example.test; office-admin@example.test',
      descriptionSnippet: 'Metadata-only preview for internal operations.',
      providerUpdatedAt: stamp(82),
      matter: null,
      matchConfidence: null,
      matchReason: null,
    },
  ];

  for (const event of calendarRows) {
    await run(
      `INSERT INTO work_calendar_events
       (id,connectedAccountId,userId,provider,providerAccountId,providerEventId,calendarId,calendarName,subject,startTime,endTime,location,meetingLink,organizer,attendeesSummary,descriptionSnippet,providerUpdatedAt,matchedMatterId,matchConfidence,matchReason,importedAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        event.id,
        event.account.id,
        admin.id,
        event.account.provider,
        event.account.providerAccountId,
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
        event.matter?.id || null,
        event.matchConfidence,
        event.matchReason,
        event.providerUpdatedAt,
        event.providerUpdatedAt,
      ],
    );
  }

  const confirmedAt = stamp(12);
  const confirmedLinks = [
    {
      id: 'demo-work-metadata-link-email-lex-2026-0001',
      sourceType: 'email',
      sourceId: emailRows[0].id,
      matterId: estateMatter.id,
      suggestedMatterId: estateMatter.id,
      confidence: emailRows[0].matchConfidence,
      reason: emailRows[0].matchReason,
    },
    {
      id: 'demo-work-metadata-link-calendar-lex-2026-0005',
      sourceType: 'calendar',
      sourceId: calendarRows[0].id,
      matterId: housingMatter.id,
      suggestedMatterId: housingMatter.id,
      confidence: calendarRows[0].matchConfidence,
      reason: calendarRows[0].matchReason,
    },
  ];

  for (const link of confirmedLinks) {
    await run(
      `INSERT INTO work_metadata_matter_links
       (id,sourceType,sourceId,matterId,suggestedMatterId,confidence,reason,status,confirmedBy,confirmedAt,unlinkedBy,unlinkedAt,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [link.id, link.sourceType, link.sourceId, link.matterId, link.suggestedMatterId, link.confidence, link.reason, 'confirmed', admin.id, confirmedAt, null, null, confirmedAt, confirmedAt],
    );
  }
}

async function main() {
  console.log(`Seeding LexFlow demo database at ${dbPath}`);
  await createSchema();
  const password = await hashPassword('password123');

  await run('INSERT INTO firm_settings (id,name,logo,primaryColor,accentColor,websiteURL,email,phone,address,themeJson) VALUES (?,?,?,?,?,?,?,?,?,?)', ['default', 'Achoki & Co. Advocates', '', '#0F1B33', '#D4A34A', 'https://lexflow.co.ke', 'info@achokilaw.co.ke', '+254 711 204 880', 'ICEA Building, Kenyatta Avenue, Nairobi', null]);
  await run('INSERT INTO reminder_settings (id,remindersEnabled,whatsappEnabled,emailEnabled) VALUES (?,?,?,?)', ['default', 1, 0, 0]);
  for (const [eventType, channel, subject, body] of defaultReminderTemplates) {
    await run('INSERT INTO reminder_templates (id,eventType,channel,subject,body,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)', [id('RT'), eventType, channel, subject, body, 'system', nowIso()]);
  }

  const admin = { id: 'seed-admin', email: 'admin@lexflow.co.ke', fullName: 'Laban Achoki', role: 'admin' };
  const advocates = [
    { id: id('U'), email: 'sarah.mwangi@achokilaw.co.ke', fullName: 'Sarah Mwangi', role: 'advocate' },
    { id: id('U'), email: 'michael.oduor@achokilaw.co.ke', fullName: 'Michael Oduor', role: 'advocate' },
    { id: id('U'), email: 'achieng.otieno@achokilaw.co.ke', fullName: 'Achieng Otieno', role: 'advocate' },
  ];
  const assistants = [
    { id: id('U'), email: 'david.wanjiku@achokilaw.co.ke', fullName: 'David Wanjiku', role: 'assistant' },
    { id: id('U'), email: 'lisa.achieng@achokilaw.co.ke', fullName: 'Lisa Achieng', role: 'assistant' },
  ];
  for (const user of [admin, ...advocates, ...assistants]) {
    await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt,tokenVersion,isActive) VALUES (?,?,?,?,?,?,?,?,?)', [user.id, user.email, password, user.fullName, user.role, '', nowIso(), 1, 1]);
  }

  const clientSpecs = [
    ['Margaret Wairimu', 'Individual', 'Active', 'margaret.wairimu@example.co.ke', '+254712456001', 180000, 670],
    ['Kamau Logistics Ltd', 'Company', 'Active', 'legal@kamaulogistics.co.ke', '+254733220018', 25000, 540],
    ['Omondi & Sons Hardware', 'Company', 'Active', 'accounts@omondihardware.co.ke', '+254722887440', 8000, 430],
    ['Grace Njeri', 'Individual', 'Active', 'grace.njeri@example.com', '+254701992331', 5000, 310],
    ['Tujenge Housing Sacco', 'Public Institution', 'Active', 'secretariat@tujenge.go.ke', '+254709771200', 200000, 290],
    ['Brian Kiptoo', 'Individual', 'Inactive', 'brian.kiptoo@example.com', '+254745902113', 0, 210],
    ['Lakeview Medical Centre Ltd', 'Company', 'Active', 'admin@lakeviewmedical.co.ke', '+254720440055', 65000, 120],
    ['Fatuma Hassan', 'Individual', 'Active', 'fatuma.hassan@example.co.ke', '+254718991212', 15000, 45],
  ];
  const clients = [];
  for (let i = 0; i < clientSpecs.length; i += 1) {
    const [name, type, status, email, phone, retainer, joinedDays] = clientSpecs[i];
    const client = { id: id('C'), userId: id('U'), name, type, status, email, phone, retainer, joinDate: daysAgo(joinedDays) };
    clients.push(client);
    await run('INSERT INTO clients (id,name,type,contact,email,phone,status,joinDate,conflictCleared,retainer,remindersEnabled,preferredChannel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [client.id, name, type, name, email, phone, status, client.joinDate, 1, retainer, 1, i % 3 === 0 ? 'both' : 'firm_default']);
    await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt,tokenVersion,isActive) VALUES (?,?,?,?,?,?,?,?,?)', [client.userId, email, password, name, 'client', client.id, nowIso(), 1, 1]);
  }

  const matterSpecs = [
    [0, 'Estate Administration of Wairimu Family', 'Active', 'Succession', 'Sarah Mwangi', 'Critical', 'hourly', 22000, 180000, 500, 'High Court Family Division', 'Hon. Justice Musyoka', 'HC-FAM-E102/2025', 'Mwikali & Co. Advocates', 90],
    [1, 'Fleet Leasing Contract Review', 'Engagement', 'Commercial Law', 'Sarah Mwangi', 'High', 'fixed', 18000, 25000, 420, '', '', '', '', 0],
    [2, 'Debt Recovery Against County Supplier', 'Discovery', 'Commercial Litigation', 'Michael Oduor', 'High', 'hourly', 16000, 8000, 360, 'Milimani Commercial Court', 'Hon. L. Mutai', 'MCCC/E401/2025', 'Kariuki Njenga LLP', 120],
    [3, 'Employment Termination Claim', 'Trial Prep', 'Employment', 'Achieng Otieno', 'Medium', 'hourly', 14000, 5000, 330, 'Employment and Labour Relations Court', 'Hon. Justice Nduma', 'ELRC/E212/2025', 'Otieno Rachier Advocates', 75],
    [4, 'Affordable Housing Procurement Review', 'Active', 'Constitutional', 'Sarah Mwangi', 'Critical', 'hourly', 25000, 200000, 300, 'Constitutional and Human Rights Division', 'Hon. Justice Mugambi', 'CHRPET/E045/2025', 'State Law Office', 45],
    [5, 'Criminal Appeal Advisory', 'Closed', 'Criminal', 'Michael Oduor', 'Low', 'fixed', 12000, 0, 260, 'High Court Criminal Division', 'Hon. Justice Kimaru', 'HCCR/A017/2025', '', 0],
    [6, 'Medical Negligence Defence', 'Discovery', 'Tort', 'Achieng Otieno', 'High', 'hourly', 18000, 65000, 180, 'High Court Civil Division', 'Hon. Justice Ongeri', 'HCCC/E771/2025', 'Wekesa & Co.', 160],
    [7, 'Land Boundary Dispute - Kitengela', 'Conflict Check', 'Land', 'Michael Oduor', 'Medium', 'fixed', 15000, 15000, 160, 'Kajiado ELC', 'Hon. Justice Bor', 'ELC/E055/2025', 'Munyao Kayugira Advocates', 210],
    [0, 'Family Trust Compliance Review', 'On Hold', 'Trusts', 'Sarah Mwangi', 'Medium', 'hourly', 20000, 60000, 140, '', '', '', '', 15],
    [1, 'Employment Contract Templates', 'Closed', 'Employment', 'Achieng Otieno', 'Low', 'fixed', 10000, 10000, 130, '', '', '', '', 0],
    [2, 'Trademark Opposition Response', 'Intake', 'Intellectual Property', 'Sarah Mwangi', 'Medium', 'hourly', 17000, 0, 110, '', '', '', 'Anjarwalla IP Team', 180],
    [3, 'Assault Charge Representation', 'Active', 'Criminal', 'Michael Oduor', 'Critical', 'hourly', 15000, 3000, 80, 'Makadara Law Courts', 'Hon. M. Mwangi', 'CR/E334/2026', '', 60],
    [4, 'Sacco Member Disciplinary Appeal', 'Engagement', 'Administrative Law', 'Achieng Otieno', 'Medium', 'hourly', 13000, 90000, 70, 'Cooperative Tribunal', 'Chairperson K. Muriithi', 'CT/APP/044/2026', 'Ochieng Onyango Advocates', 100],
    [6, 'Hospital Lease Renewal', 'Active', 'Real Estate', 'Sarah Mwangi', 'High', 'hourly', 19000, 65000, 35, '', '', '', '', 0],
    [7, 'Refugee Status Appeal', 'Trial Prep', 'Human Rights', 'Achieng Otieno', 'High', 'hourly', 11000, 15000, 25, 'High Court Judicial Review', 'Hon. Justice Mwita', 'JR/E018/2026', 'Attorney General', 120],
  ];
  const matters = [];
  for (let i = 0; i < matterSpecs.length; i += 1) {
    const [clientIndex, title, stage, practiceArea, advocate, priority, billingType, rate, retainerBalance, openDays, court, judge, caseNo, opposingCounsel, solDays] = matterSpecs[i];
    const matter = { id: id('M'), reference: `LEX-2026-${String(i + 1).padStart(4, '0')}`, clientId: clients[clientIndex].id, title, stage, practiceArea, advocate, priority, billingType, rate, retainerBalance };
    matters.push(matter);
    const fixedFee = billingType === 'fixed' ? rate * 6 : 0;
    await run(`INSERT INTO matters (id,reference,clientId,title,practiceArea,stage,assignedTo,paralegal,openDate,description,court,judge,caseNo,opposingCounsel,billingRate,retainerBalance,totalBilled,priority,solDate,billingType,fixedFee,remindersEnabled,courtRemindersEnabled,invoiceRemindersEnabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [matter.id, matter.reference, matter.clientId, title, practiceArea, stage, advocate, pick(assistants, i).fullName, daysAgo(openDays), `${practiceArea} matter for ${clients[clientIndex].name}. Seeded for product testing.`, court, judge, caseNo, opposingCounsel, rate, retainerBalance, 0, priority, solDays ? daysFromNow(solDays) : '', billingType, fixedFee, 'firm_default', 'firm_default', 'firm_default']);
  }

  const taskTitles = ['Draft pleadings', 'File notice of motion', 'Client conference', 'Review discovery documents', 'Prepare hearing bundle', 'Serve opposing counsel', 'Update client portal', 'Research authorities', 'Confirm court date', 'Prepare witness questions'];
  const tasks = [];
  for (let i = 0; i < matters.length; i += 1) {
    const count = 2 + (i % 4);
    for (let j = 0; j < count; j += 1) {
      const task = { id: id('T'), matterId: matters[i].id, title: pick(taskTitles, i + j), completed: (i + j) % 3 === 0 ? 1 : 0, assignee: j % 3 === 0 ? matters[i].advocate : pick(assistants, i + j).fullName, dueDate: (i + j) % 5 === 0 ? daysAgo(2 + j) : daysFromNow(3 + i + j), auto: j === 0 ? 1 : 0 };
      tasks.push(task);
      await run('INSERT INTO tasks (id,matterId,title,completed,assignee,dueDate,auto_generated) VALUES (?,?,?,?,?,?,?)', [task.id, task.matterId, task.title, task.completed, task.assignee, task.dueDate, task.auto]);
    }
  }

  const checklistTitles = [
    'Confirm engagement letter',
    'Collect client identity documents',
    'Review pleadings bundle',
    'Update matter chronology',
    'Confirm next court attendance',
    'Send client status update',
  ];
  for (let i = 0; i < Math.min(6, matters.length); i += 1) {
    const matter = matters[i];
    await run(
      'INSERT INTO matter_checklist_items (id,matterId,title,completed,position,notes,createdBy,createdAt,completedAt,completedBy) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id('CHK'), matter.id, pick(checklistTitles, i), i % 3 === 0 ? 1 : 0, 0, 'Seeded manual checklist item.', admin.id, nowIso(), i % 3 === 0 ? nowIso() : '', i % 3 === 0 ? admin.fullName : ''],
    );
    await run(
      'INSERT INTO matter_checklist_items (id,matterId,title,completed,position,notes,createdBy,createdAt,completedAt,completedBy) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id('CHK'), matter.id, pick(checklistTitles, i + 2), 0, 1, '', admin.id, nowIso(), '', ''],
    );
  }

  const checklistTemplates = [
    {
      name: 'Litigation Intake',
      description: 'Standard opening checks before pleadings and court tracking.',
      practiceArea: 'Litigation',
      items: [
        ['Confirm instructions and engagement terms', 'Capture scope, retainer position, and responsible advocate.'],
        ['Run conflict and limitation checks', 'Record conflict clearance and diarise any limitation risk.'],
        ['Collect pleadings and authority documents', 'Upload initial bundle before drafting.'],
      ],
    },
    {
      name: 'Court Hearing Preparation',
      description: 'Reusable pre-hearing file review checklist.',
      practiceArea: 'Court',
      items: [
        ['Confirm hearing date and virtual court link', 'Verify listing, time, and access details.'],
        ['Prepare indexed hearing bundle', 'Check pleadings, authorities, and affidavits.'],
        ['Send client hearing update', 'Share attendance expectations and next steps.'],
      ],
    },
    {
      name: 'Conveyancing File Opening',
      description: 'Opening checks for land and property transactions.',
      practiceArea: 'Conveyancing',
      items: [
        ['Collect title and identity documents', 'Confirm client, vendor, and property documents.'],
        ['Review rates, rent, and consent requirements', 'Note any statutory or county clearances needed.'],
        ['Prepare completion checklist', 'List searches, consents, payments, and registration steps.'],
      ],
    },
  ];
  for (const template of checklistTemplates) {
    const templateId = id('CTPL');
    const createdAt = nowIso();
    await run(
      'INSERT INTO checklist_templates (id,name,description,practiceArea,active,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)',
      [templateId, template.name, template.description, template.practiceArea, 1, admin.id, createdAt, createdAt],
    );
    for (let position = 0; position < template.items.length; position += 1) {
      const [title, notes] = template.items[position];
      await run(
        'INSERT INTO checklist_template_items (id,templateId,title,notes,position,createdAt) VALUES (?,?,?,?,?,?)',
        [id('CTI'), templateId, title, notes, position, createdAt],
      );
    }
  }

  const documentTemplates = [
    {
      name: 'General Practice - Client Update Letter',
      description: 'Short client status update for any active matter.',
      practiceArea: 'General Practice',
      category: 'Letter',
      bodyMarkup: [
        'Dear {{client.name}},',
        '',
        'RE: {{matter.title}} ({{matter.reference}})',
        '',
        'We write to update you on the current status of the above matter as at {{today}}.',
        'Current stage: {{matter.stage}}',
        'Assigned advocate: {{matter.assignedAdvocate}}',
        '',
        'We will continue to keep you informed of material developments.',
        '',
        'Yours faithfully,',
        '{{user.fullName}}',
        '{{firm.name}}',
      ].join('\n'),
    },
    {
      name: 'Litigation - Mention Attendance Note',
      description: 'Concise post-mention attendance note for court-tracked matters.',
      practiceArea: 'Litigation',
      category: 'Court Attendance',
      bodyMarkup: [
        'Matter: {{matter.title}}',
        'Reference: {{matter.reference}}',
        'Court: {{matter.court}}',
        'Case number: {{matter.caseNo}}',
        '',
        'Attendance note prepared on {{today}} by {{user.fullName}}.',
        '',
        'The matter was reviewed for attendance, directions, and next steps. The client should be updated once the court record is confirmed.',
        '',
        '{{firm.name}}',
      ].join('\n'),
    },
    {
      name: 'Probate - Estate Administration Client Update',
      description: 'Client update for succession and estate administration matters.',
      practiceArea: 'Probate and Administration',
      category: 'Letter',
      bodyMarkup: [
        'Dear {{client.name}},',
        '',
        'RE: {{matter.title}} - {{matter.reference}}',
        '',
        'We refer to the estate administration matter above and confirm that the file remains at the {{matter.stage}} stage.',
        '',
        'Court: {{matter.court}}',
        'Case number: {{matter.caseNo}}',
        '',
        'We will notify you after the next registry or court update.',
        '',
        'Yours faithfully,',
        '{{firm.name}}',
      ].join('\n'),
    },
    {
      name: 'Commercial Law - Demand / Status Letter',
      description: 'Short commercial matter status or demand follow-up letter.',
      practiceArea: 'Commercial Law',
      category: 'Letter',
      bodyMarkup: [
        '{{client.name}}',
        '{{client.email}}',
        '',
        'Dear {{client.name}},',
        '',
        'RE: {{matter.title}} ({{matter.reference}})',
        '',
        'We write to provide a brief status update on the above commercial matter as at {{today}}.',
        'Matter stage: {{matter.stage}}',
        'Assigned advocate: {{matter.assignedAdvocate}}',
        '',
        'Please contact us if you would like to discuss the next practical steps.',
        '',
        '{{user.fullName}}',
        '{{firm.name}}',
        '{{firm.email}}',
        '{{firm.phone}}',
      ].join('\n'),
    },
  ];
  for (const template of documentTemplates) {
    const createdAt = nowIso();
    await run(
      'INSERT INTO document_templates (id,name,description,practiceArea,category,bodyMarkup,active,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id('DTPL'), template.name, template.description, template.practiceArea, template.category, template.bodyMarkup, 1, admin.id, createdAt, createdAt],
    );
  }

  const activities = ['Research', 'Drafting', 'Court Appearance', 'Client Call', 'Document Review', 'Filing', 'Preparation', 'Negotiation'];
  const sarahMatters = matters.filter(m => m.advocate === 'Sarah Mwangi');
  for (let i = 0; i < 120; i += 1) {
    const matter = i < 55 ? pick(sarahMatters, i) : matters[i % matters.length];
    const matterTasks = tasks.filter(t => t.matterId === matter.id);
    const task = i % 3 === 0 && matterTasks.length ? pick(matterTasks, i) : null;
    const hours = [0.5, 0.8, 1.2, 1.5, 2, 2.5, 3, 4, 5.5, 6, 8][i % 11];
    const billed = i % 10 < 6 ? 1 : 0;
    await run('INSERT INTO time_entries (id,matterId,taskId,attorney,date,hours,activity,description,rate,billed) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('TIME'), matter.id, task?.id || '', matter.advocate, daysAgo(i % 180), hours, pick(activities, i), `${pick(activities, i)} on ${matter.title}`, matter.rate, billed]);
  }

  const invoices = [];
  let seededReceiptSeq = 0;
  for (let i = 0; i < 12; i += 1) {
    const matter = matters[i];
    const invId = id('INV');
    const status = i % 4 === 0 ? 'Paid' : i % 4 === 1 ? 'Outstanding' : i % 4 === 2 ? 'Overdue' : 'Paid';
    const amount = 25000 + (i * 17500);
    const date = daysAgo(70 - i * 4);
    const dueDate = status === 'Overdue' ? daysAgo(10 + i) : daysFromNow(14 + i);
    invoices.push({ id: invId, matterId: matter.id, clientId: matter.clientId, amount, status });
    await run('INSERT INTO invoices (id,matterId,clientId,number,date,amount,status,dueDate,description,source) VALUES (?,?,?,?,?,?,?,?,?,?)', [invId, matter.id, matter.clientId, `INV-2026-${String(i + 1).padStart(4, '0')}`, date, amount, status, dueDate, `Professional fees for ${matter.title}`, matter.billingType]);
    for (let j = 0; j < 3; j += 1) {
      await run('INSERT INTO invoice_items (id,invoiceId,timeEntryId,date,description,hours,rate,amount) VALUES (?,?,?,?,?,?,?,?)', [id('ITEM'), invId, '', date, pick(activities, i + j), 1 + j, matter.rate, Math.round(amount / 3)]);
    }
    if (status === 'Paid' || i % 5 === 1) {
      const paidAmount = status === 'Paid' ? amount : Math.round(amount * 0.4);
      seededReceiptSeq += 1;
      const receiptNumber = `RCPT-2026-${String(seededReceiptSeq).padStart(6, '0')}`;
      const receiptIssuedAt = nowIso();
      await run('INSERT INTO payments (id,invoiceId,matterId,clientId,amount,method,reference,date,note,proofId,createdBy,createdAt,receiptNumber,receiptIssuedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id('PAY'), invId, matter.id, matter.clientId, paidAmount, pick(['M-PESA', 'Bank Transfer', 'Cash'], i), moneyRef(i), daysAgo(20 - i), status === 'Paid' ? 'Full settlement' : 'Partial payment', '', admin.id, nowIso(), receiptNumber, receiptIssuedAt]);
      await run('INSERT INTO payment_proofs (id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,content,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id('PP'), invId, matter.id, matter.clientId, 'M-PESA', moneyRef(i), paidAmount, 'Demo payment proof', `payment-${i + 1}.png`, 'image/png', '14 KB', Buffer.from('demo payment proof'), nowIso()]);
    }
  }
  await run('INSERT INTO receipt_sequences (year, lastSeq) VALUES (?, ?)', ['2026', seededReceiptSeq]);

  for (let i = 0; i < 18; i += 1) {
    const matter = matters[i % matters.length];
    await run('INSERT INTO disbursements (id,matterId,invoiceId,description,amount,date,billed) VALUES (?,?,?,?,?,?,?)', [id('DISB'), matter.id, i % 2 === 0 ? pick(invoices, i).id : '', pick(['Court filing fee', 'Process server', 'Travel expenses', 'Expert witness fee', 'Registry search', 'Commissioner fee'], i), 1500 + i * 1800, daysAgo(i * 7), i % 2 === 0 ? 1 : 0]);
  }
  for (let i = 0; i < 12; i += 1) {
    await run('INSERT INTO expenses (id,matterId,category,description,amount,date,vendor) VALUES (?,?,?,?,?,?,?)', [id('EXP'), i % 4 === 0 ? matters[i].id : '', pick(['Rent', 'Utilities', 'Stationery', 'Travel', 'Marketing', 'Research'], i), `${pick(['Office rent', 'Internet bundle', 'Printer toner', 'Court travel', 'Website campaign', 'Law report subscription'], i)} - demo`, 4500 + i * 6200, daysAgo(i * 14), pick(['ICEA Properties', 'Safaricom', 'Text Book Centre', 'Uber Kenya', 'Google Ads', 'Kenya Law'], i)]);
  }

  const appearanceTitles = ['Mention', 'Hearing', 'Directions', 'Ruling', 'Pre-trial conference'];
  const appearanceTimes = ['9:00 AM', '10:00 AM', '11:00 AM', '2:30 PM', '8:30 AM'];
  const appearanceOffsets = [7, 1, 2, 3, 4, 5, 6, 7, -24, -27, -30, -33, -36, -39, -42, -45, -48, -51];
  for (let i = 0; i < 18; i += 1) {
    const matter = matters[i % matters.length];
    const title = pick(appearanceTitles, i);
    const location = i === 0 ? 'High Court Family Division - Probate and Administration Registry' : matter.court || 'Milimani Law Courts';
    await run('INSERT INTO appearances (id,matterId,title,date,time,type,location,meetingLink,attorney,prepNote) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('EV'), matter.id, title, daysFromNow(appearanceOffsets[i]), pick(appearanceTimes, i), title, location, i % 4 === 0 ? `https://meet.google.com/lex-demo-${i}` : '', matter.advocate, 'Review bundle and update client after appearance.']);
  }

  for (let i = 0; i < 8; i += 1) {
    const matter = matters[i];
    const pleadings = id('FOL');
    const clientUploads = id('FOL');
    await run('INSERT INTO folders (id,matterId,name,createdBy,createdAt) VALUES (?,?,?,?,?)', [pleadings, matter.id, 'Pleadings', admin.id, nowIso()]);
    await run('INSERT INTO folders (id,matterId,name,createdBy,createdAt) VALUES (?,?,?,?,?)', [clientUploads, matter.id, 'Client Uploads', clients[i % clients.length].id, nowIso()]);
    for (let j = 0; j < 2; j += 1) {
      const source = j === 0 ? 'firm' : 'client';
      const fileName = `${source === 'firm' ? 'Draft pleading' : 'Client ID'} ${i + 1}.${j === 0 ? 'pdf' : 'png'}`;
      const docContent = j === 0 ? await seededPdfBuffer(fileName) : seededPngBuffer(i + 1);
      const docSize = `${Math.max(1, Math.round(docContent.length / 1024))} KB`;
      await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id('DOC'), matter.id, fileName, fileName, j === 0 ? 'PDF' : 'Image', j === 0 ? 'application/pdf' : 'image/png', daysAgo(i * 9 + j), docSize, docContent, source, source === 'firm' ? pleadings : clientUploads, '', '', source === 'firm' && i % 2 === 0 ? 1 : 0, source === 'firm' ? admin.id : clients[i % clients.length].id]);
    }
  }

  const requestTimes = [nowIso(), daysAgo(3), daysAgo(5)];
  const staffUserIds = [admin.id, advocates[0].id, advocates[1].id];
  const requestMatters = [matters[0], matters[1], matters[2]];
  const requestTitles = ['Signed Affidavit', 'Signed Board Resolution', 'Proof of Payment'];
  const requestDescriptions = ['Please upload a signed affidavit for the estate matter.', 'We need a signed board resolution authorising the lease terms.', 'Provide proof of payment for the county supplier debt.'];
  for (let i = 0; i < 3; i += 1) {
    const reqId = id('DR');
    const status = i === 0 ? 'pending' : i === 1 ? 'fulfilled' : 'cancelled';
    const reqMatter = requestMatters[i];
    await run('INSERT INTO document_requests (id,matterId,clientId,staffUserId,title,description,status,createdAt,respondedAt,responseDocumentId,cancelledAt,cancelledBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [reqId, reqMatter.id, reqMatter.clientId, staffUserIds[i], requestTitles[i], requestDescriptions[i], status, requestTimes[i],
       status === 'fulfilled' ? requestTimes[i] : null,
       status === 'fulfilled' ? id('DOC') : null,
       status === 'cancelled' ? requestTimes[i] : null,
       status === 'cancelled' ? staffUserIds[i] : null]);
    if (status === 'fulfilled') {
      const docId = id('DOC');
      const fulfilledContent = await seededPdfBuffer('Signed Board Resolution - Demo');
      const fulfilledSize = `${Math.max(1, Math.round(fulfilledContent.length / 1024))} KB`;
      await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [docId, reqMatter.id, 'signed-board-resolution.pdf', 'Signed Board Resolution.pdf', 'PDF', 'application/pdf', daysAgo(3), fulfilledSize, fulfilledContent, 'client', '', '', '', 0, clients[1].userId]);
      await run('UPDATE document_requests SET responseDocumentId=? WHERE id=?', [docId, reqId]);
    }
  }

  for (let i = 0; i < matters.length; i += 1) {
    await run('INSERT INTO case_notes (id,matterId,content,author,createdAt) VALUES (?,?,?,?,?)', [id('NOTE'), matters[i].id, `Internal strategy note for ${matters[i].title}.`, matters[i].advocate, nowIso()]);
    if (i % 2 === 0) {
      const client = clients.find(c => c.id === matters[i].clientId);
      await run('INSERT INTO case_notes (id,matterId,content,author,createdAt) VALUES (?,?,?,?,?)', [id('NOTE'), matters[i].id, 'Client asked for an update through the portal.', client.name, nowIso()]);
      const conversationId = id('CONV');
      const clientMessageId = id('MSG');
      const firmMessageId = id('MSG');
      const conversationStatus = i % 6 === 0 ? 'resolved' : i % 4 === 0 ? 'pending' : 'open';
      await run('INSERT INTO conversations (id,matterId,clientId,subject,createdAt,status,lastStaffReadAt,lastClientReadAt,statusUpdatedAt) VALUES (?,?,?,?,?,?,?,?,?)', [conversationId, matters[i].id, client.id, `Update request: ${matters[i].reference}`, nowIso(), conversationStatus, i % 4 === 0 ? '' : nowIso(), i % 3 === 0 ? '' : nowIso(), nowIso()]);
      await run('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)', [clientMessageId, conversationId, client.userId, 'client', 'Good afternoon, kindly update me on the current status of this matter.', nowIso()]);
      await run('INSERT INTO messages (id,conversationId,senderId,senderRole,body,createdAt) VALUES (?,?,?,?,?,?)', [firmMessageId, conversationId, admin.id, 'admin', 'Thank you. The advocate will post an update after the next court attendance.', nowIso()]);
      await run('INSERT INTO client_activity (id,clientId,matterId,userId,action,summary,entityType,entityId,createdAt) VALUES (?,?,?,?,?,?,?,?,?)', [id('CACT'), client.id, matters[i].id, client.userId, 'sent_message', 'Client asked for an update through the portal.', 'message', clientMessageId, nowIso()]);
      await run('INSERT INTO client_activity (id,clientId,matterId,userId,action,summary,entityType,entityId,createdAt) VALUES (?,?,?,?,?,?,?,?,?)', [id('CACT'), client.id, matters[i].id, admin.id, 'firm_sent_message', 'Firm replied to a client portal message.', 'message', firmMessageId, nowIso()]);
      for (const staff of [...advocates, ...assistants, admin]) {
        await run('INSERT INTO notifications (id,userId,type,matterId,clientId,title,body,createdAt,readAt) VALUES (?,?,?,?,?,?,?,?,?)', [id('NOTIF'), staff.id, 'client_message', matters[i].id, client.id, 'Client sent a message', `${client.name}: Client asked for an update through the portal.`, nowIso(), i % 4 === 0 ? '' : nowIso()]);
      }
    }
  }

  const deadlineTypes = ['tax', 'statutory', 'client', 'internal', 'regulatory'];
  for (let i = 0; i < 10; i += 1) {
    const matter = matters[i % matters.length];
    await run('INSERT INTO deadlines (id,matterId,clientId,title,type,dueDate,owner,status,notes,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id('DL'), matter.id, matter.clientId, pick(['VAT return review', 'Client document deadline', 'File submissions', 'AML source of funds review', 'Annual return check'], i), pick(deadlineTypes, i), i % 4 === 0 ? daysAgo(i + 1) : daysFromNow(i + 2), matter.advocate, i % 5 === 0 ? 'Done' : 'Open', 'Seeded compliance/deadline item.', admin.id, nowIso()]);
  }

  const recessNotice = id('NOTICE');
  const portalNotice = id('NOTICE');
  await run('INSERT INTO firm_notices (id,title,content,createdAt,createdBy,clientId) VALUES (?,?,?,?,?,?)', [recessNotice, 'Court recess notice', 'Please note that some court stations may adjust dates during recess. The firm will confirm your matter dates directly.', nowIso(), admin.fullName, '']);
  await run('INSERT INTO firm_notices (id,title,content,createdAt,createdBy,clientId) VALUES (?,?,?,?,?,?)', [portalNotice, 'Client portal launch', 'Clients can now upload documents and payment proof directly through the secure portal.', nowIso(), admin.fullName, clients[0].id]);
  const noticeDocContent = await seededPdfBuffer('Court Recess Guidance - Demo');
  const noticeDocSize = `${Math.max(1, Math.round(noticeDocContent.length / 1024))} KB`;
  await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id('DOC'), '', 'court-recess-guidance.pdf', 'Court recess guidance.pdf', 'PDF', 'application/pdf', today.toISOString().slice(0, 10), noticeDocSize, noticeDocContent, 'firm', '', '', recessNotice, 1, admin.id]);

  await seedIntegrationMetadata({ admin, matters });

  const auditItems = [
    ['create', 'client', clients[0].id, 'Created demo client records'],
    ['create', 'matter', matters[0].id, 'Opened demo matter files'],
    ['upload', 'document', 'seed-docs', 'Uploaded demo documents'],
    ['create', 'invoice', invoices[0].id, 'Generated demo invoices'],
    ['create', 'deadline', 'seed-deadlines', 'Seeded statutory and client deadlines'],
  ];
  for (const item of auditItems) await insertAudit(...item, admin.fullName, 'admin');

  console.log('Demo data seeded successfully.');
  console.log('Login credentials:');
  console.log('  Admin: admin@lexflow.co.ke / password123');
  console.log('  Advocate: sarah.mwangi@achokilaw.co.ke / password123');
  console.log('  Assistant: david.wanjiku@achokilaw.co.ke / password123');
  console.log(`  Client: ${clients[0].email} / password123`);
}

main()
  .then(() => db.close())
  .catch(err => {
    console.error('Demo seed failed:', err);
    db.close();
    process.exit(1);
  });
