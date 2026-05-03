const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, '..', 'lawfirm.db');
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
    'audit_logs', 'notifications', 'payment_proofs', 'payments', 'expenses', 'disbursements', 'invoice_items', 'invoices',
    'messages', 'conversations', 'client_activity', 'case_notes', 'documents', 'folders', 'appearances', 'time_entries', 'tasks', 'deadlines', 'matters', 'clients',
    'users', 'integrations_log', 'firm_settings', 'reminder_settings', 'reminder_templates', 'reminder_logs',
    'firm_notices', 'invitations',
  ];
  await run('PRAGMA foreign_keys=OFF');
  for (const table of tables) await run(`DROP TABLE IF EXISTS ${table}`);

  await run(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin','client')) DEFAULT 'assistant', clientId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'Individual', contact TEXT, email TEXT, phone TEXT, status TEXT DEFAULT 'Active', joinDate TEXT, conflictCleared INTEGER DEFAULT 0, retainer REAL DEFAULT 0, remindersEnabled INTEGER DEFAULT 1, preferredChannel TEXT DEFAULT 'firm_default')`);
  await run(`CREATE TABLE matters (id TEXT PRIMARY KEY, reference TEXT UNIQUE, clientId TEXT NOT NULL, title TEXT NOT NULL, practiceArea TEXT, stage TEXT DEFAULT 'Intake', assignedTo TEXT, paralegal TEXT, openDate TEXT, description TEXT, court TEXT, judge TEXT, caseNo TEXT, opposingCounsel TEXT, billingRate REAL DEFAULT 0, retainerBalance REAL DEFAULT 0, totalBilled REAL DEFAULT 0, priority TEXT DEFAULT 'Medium', solDate TEXT, billingType TEXT DEFAULT 'hourly', fixedFee REAL DEFAULT 0, remindersEnabled TEXT DEFAULT 'firm_default', courtRemindersEnabled TEXT DEFAULT 'firm_default', invoiceRemindersEnabled TEXT DEFAULT 'firm_default')`);
  await run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, assignee TEXT, dueDate TEXT, auto_generated INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE time_entries (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, taskId TEXT, attorney TEXT, date TEXT, hours REAL DEFAULT 0, activity TEXT, description TEXT, rate REAL DEFAULT 0, billed INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE appearances (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT, date TEXT, time TEXT, type TEXT, location TEXT, meetingLink TEXT, attorney TEXT, prepNote TEXT)`);
  await run(`CREATE TABLE folders (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE documents (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT, displayName TEXT, type TEXT, mimeType TEXT, date TEXT, size TEXT, content BLOB, source TEXT DEFAULT 'firm', folderId TEXT, messageId TEXT, noticeId TEXT, clientVisible INTEGER DEFAULT 0, uploadedBy TEXT)`);
  await run(`CREATE TABLE case_notes (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, content TEXT NOT NULL, author TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE invoices (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT, number TEXT, date TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'Outstanding', dueDate TEXT, description TEXT, source TEXT DEFAULT 'time')`);
  await run(`CREATE TABLE invoice_items (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, timeEntryId TEXT, date TEXT, description TEXT, hours REAL DEFAULT 0, rate REAL DEFAULT 0, amount REAL DEFAULT 0)`);
  await run(`CREATE TABLE payments (id TEXT PRIMARY KEY, invoiceId TEXT, matterId TEXT, clientId TEXT, method TEXT, reference TEXT, amount REAL DEFAULT 0, date TEXT, note TEXT)`);
  await run(`CREATE TABLE disbursements (id TEXT PRIMARY KEY, matterId TEXT, invoiceId TEXT, description TEXT, amount REAL DEFAULT 0, date TEXT, billed INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE expenses (id TEXT PRIMARY KEY, matterId TEXT, category TEXT, description TEXT, amount REAL DEFAULT 0, date TEXT, vendor TEXT)`);
  await run(`CREATE TABLE integrations_log (id TEXT PRIMARY KEY, type TEXT NOT NULL, matterId TEXT, clientId TEXT, recipient TEXT, message TEXT, status TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE firm_settings (id TEXT PRIMARY KEY, name TEXT, logo TEXT, primaryColor TEXT, accentColor TEXT, websiteURL TEXT, email TEXT, phone TEXT, address TEXT)`);
  await run(`CREATE TABLE reminder_settings (id TEXT PRIMARY KEY, remindersEnabled INTEGER DEFAULT 1, whatsappEnabled INTEGER DEFAULT 0, emailEnabled INTEGER DEFAULT 0, twilioSid TEXT, twilioToken TEXT, twilioFromNumber TEXT, smtpHost TEXT, smtpPort TEXT, smtpUser TEXT, smtpPass TEXT)`);
  await run(`CREATE TABLE reminder_templates (id TEXT PRIMARY KEY, eventType TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE reminder_logs (id TEXT PRIMARY KEY, templateId TEXT, clientId TEXT, matterId TEXT, invoiceId TEXT, channel TEXT, recipient TEXT, status TEXT, sentAt TEXT, errorMessage TEXT)`);
  await run(`CREATE TABLE firm_notices (id TEXT PRIMARY KEY, title TEXT, content TEXT, createdAt TEXT, createdBy TEXT, clientId TEXT DEFAULT '')`);
  await run(`CREATE TABLE conversations (id TEXT PRIMARY KEY, matterId TEXT, clientId TEXT NOT NULL, subject TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT, senderRole TEXT, body TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE client_activity (id TEXT PRIMARY KEY, clientId TEXT, matterId TEXT, userId TEXT, action TEXT, summary TEXT, entityType TEXT, entityId TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE deadlines (id TEXT PRIMARY KEY, matterId TEXT, clientId TEXT, title TEXT NOT NULL, type TEXT DEFAULT 'internal', dueDate TEXT NOT NULL, owner TEXT, status TEXT DEFAULT 'Open', notes TEXT, createdBy TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE payment_proofs (id TEXT PRIMARY KEY, invoiceId TEXT, matterId TEXT, clientId TEXT, method TEXT, reference TEXT, amount REAL DEFAULT 0, note TEXT, fileName TEXT, mimeType TEXT, size TEXT, content BLOB, createdAt TEXT)`);
  await run(`CREATE TABLE invitations (id TEXT PRIMARY KEY, email TEXT NOT NULL, clientId TEXT, token TEXT UNIQUE NOT NULL, status TEXT DEFAULT 'pending', createdBy TEXT, createdAt TEXT, expiresAt TEXT)`);
  await run(`CREATE TABLE audit_logs (id TEXT PRIMARY KEY, userId TEXT, userName TEXT, role TEXT, action TEXT, entityType TEXT, entityId TEXT, summary TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE notifications (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT, matterId TEXT, clientId TEXT, title TEXT, body TEXT, createdAt TEXT, readAt TEXT)`);
}

async function insertAudit(action, entityType, entityId, summary, userName = 'Demo Seeder', role = 'admin') {
  await run('INSERT INTO audit_logs (id,userId,userName,role,action,entityType,entityId,summary,createdAt) VALUES (?,?,?,?,?,?,?,?,?)', [id('AUD'), 'seed-admin', userName, role, action, entityType, entityId, summary, nowIso()]);
}

async function main() {
  console.log(`Seeding LexFlow demo database at ${dbPath}`);
  await createSchema();
  const password = await bcrypt.hash('password123', 10);

  await run('INSERT INTO firm_settings (id,name,logo,primaryColor,accentColor,websiteURL,email,phone,address) VALUES (?,?,?,?,?,?,?,?,?)', ['default', 'Achoki & Co. Advocates', '', '#0F1B33', '#D4A34A', 'https://lexflow.co.ke', 'info@achokilaw.co.ke', '+254 711 204 880', 'ICEA Building, Kenyatta Avenue, Nairobi']);
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
    await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt) VALUES (?,?,?,?,?,?,?)', [user.id, user.email, password, user.fullName, user.role, '', nowIso()]);
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
    await run('INSERT INTO users (id,email,password,fullName,role,clientId,createdAt) VALUES (?,?,?,?,?,?,?)', [client.userId, email, password, name, 'client', client.id, nowIso()]);
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
      await run('INSERT INTO payments (id,invoiceId,matterId,clientId,method,reference,amount,date,note) VALUES (?,?,?,?,?,?,?,?,?)', [id('PAY'), invId, matter.id, matter.clientId, pick(['M-PESA', 'Bank Transfer', 'Cash'], i), moneyRef(i), paidAmount, daysAgo(20 - i), status === 'Paid' ? 'Full settlement' : 'Partial payment']);
      await run('INSERT INTO payment_proofs (id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,content,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id('PP'), invId, matter.id, matter.clientId, 'M-PESA', moneyRef(i), paidAmount, 'Demo payment proof', `payment-${i + 1}.png`, 'image/png', '14 KB', Buffer.from('demo payment proof'), nowIso()]);
    }
  }

  for (let i = 0; i < 18; i += 1) {
    const matter = matters[i % matters.length];
    await run('INSERT INTO disbursements (id,matterId,invoiceId,description,amount,date,billed) VALUES (?,?,?,?,?,?,?)', [id('DISB'), matter.id, i % 2 === 0 ? pick(invoices, i).id : '', pick(['Court filing fee', 'Process server', 'Travel expenses', 'Expert witness fee', 'Registry search', 'Commissioner fee'], i), 1500 + i * 1800, daysAgo(i * 7), i % 2 === 0 ? 1 : 0]);
  }
  for (let i = 0; i < 12; i += 1) {
    await run('INSERT INTO expenses (id,matterId,category,description,amount,date,vendor) VALUES (?,?,?,?,?,?,?)', [id('EXP'), i % 4 === 0 ? matters[i].id : '', pick(['Rent', 'Utilities', 'Stationery', 'Travel', 'Marketing', 'Research'], i), `${pick(['Office rent', 'Internet bundle', 'Printer toner', 'Court travel', 'Website campaign', 'Law report subscription'], i)} - demo`, 4500 + i * 6200, daysAgo(i * 14), pick(['ICEA Properties', 'Safaricom', 'Text Book Centre', 'Uber Kenya', 'Google Ads', 'Kenya Law'], i)]);
  }

  const appearanceTitles = ['Mention', 'Hearing', 'Directions', 'Ruling', 'Pre-trial conference'];
  for (let i = 0; i < 18; i += 1) {
    const matter = matters[i % matters.length];
    const offset = i === 0 ? 0 : i === 1 ? 1 : i < 8 ? i + 2 : -(i * 3);
    await run('INSERT INTO appearances (id,matterId,title,date,time,type,location,meetingLink,attorney,prepNote) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('EV'), matter.id, pick(appearanceTitles, i), daysFromNow(offset), `${8 + (i % 5)}:00 AM`, pick(appearanceTitles, i), matter.court || 'Milimani Law Courts', i % 4 === 0 ? `https://meet.google.com/lex-demo-${i}` : '', matter.advocate, 'Review bundle and update client after appearance.']);
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
      await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id('DOC'), matter.id, fileName, fileName, j === 0 ? 'PDF' : 'Image', j === 0 ? 'application/pdf' : 'image/png', daysAgo(i * 9 + j), `${18 + i + j} KB`, Buffer.from(`Demo document ${i}-${j}`), source, source === 'firm' ? pleadings : clientUploads, '', '', source === 'firm' && i % 2 === 0 ? 1 : 0, source === 'firm' ? admin.id : clients[i % clients.length].id]);
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
      await run('INSERT INTO conversations (id,matterId,clientId,subject,createdAt) VALUES (?,?,?,?,?)', [conversationId, matters[i].id, client.id, `Update request: ${matters[i].reference}`, nowIso()]);
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
  await run(`INSERT INTO documents (id,matterId,name,displayName,type,mimeType,date,size,content,source,folderId,messageId,noticeId,clientVisible,uploadedBy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id('DOC'), '', 'court-recess-guidance.pdf', 'Court recess guidance.pdf', 'PDF', 'application/pdf', today.toISOString().slice(0, 10), '12 KB', Buffer.from('Demo notice attachment'), 'firm', '', '', recessNotice, 1, admin.id]);

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
