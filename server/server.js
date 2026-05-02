const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');

const app = express();
const db = new sqlite3.Database(path.join(__dirname, 'lawfirm.db'));
const JWT_SECRET = process.env.JWT_SECRET || 'lexflow-kenya-secret';

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

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some(existing => existing.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, fullName TEXT, role TEXT CHECK(role IN ('advocate','assistant','admin')) DEFAULT 'assistant', createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'Individual', contact TEXT, email TEXT, phone TEXT, status TEXT DEFAULT 'Active', joinDate TEXT, conflictCleared INTEGER DEFAULT 0, retainer REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, reference TEXT UNIQUE, clientId TEXT NOT NULL, title TEXT NOT NULL, practiceArea TEXT, stage TEXT DEFAULT 'Intake', assignedTo TEXT, paralegal TEXT, openDate TEXT, description TEXT, court TEXT, judge TEXT, caseNo TEXT, opposingCounsel TEXT, billingRate REAL DEFAULT 0, retainerBalance REAL DEFAULT 0, totalBilled REAL DEFAULT 0, priority TEXT DEFAULT 'Medium', solDate TEXT, billingType TEXT DEFAULT 'hourly', fixedFee REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER DEFAULT 0, assignee TEXT, dueDate TEXT, auto_generated INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS time_entries (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, attorney TEXT, date TEXT, hours REAL DEFAULT 0, activity TEXT, description TEXT, rate REAL DEFAULT 0, billed INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS appearances (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, title TEXT, date TEXT, time TEXT, type TEXT, location TEXT, meetingLink TEXT, attorney TEXT, prepNote TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, name TEXT, type TEXT, mimeType TEXT, date TEXT, size TEXT, content BLOB)`);
  await run(`CREATE TABLE IF NOT EXISTS case_notes (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, content TEXT NOT NULL, author TEXT, createdAt TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, matterId TEXT NOT NULL, clientId TEXT, number TEXT, date TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'Outstanding', dueDate TEXT, description TEXT, source TEXT DEFAULT 'time')`);
  await run(`CREATE TABLE IF NOT EXISTS invoice_items (id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL, timeEntryId TEXT, date TEXT, description TEXT, hours REAL DEFAULT 0, rate REAL DEFAULT 0, amount REAL DEFAULT 0)`);
  await run(`CREATE TABLE IF NOT EXISTS integrations_log (id TEXT PRIMARY KEY, type TEXT NOT NULL, matterId TEXT, clientId TEXT, recipient TEXT, message TEXT, status TEXT, createdAt TEXT)`);

  await ensureColumn('appearances', 'meetingLink', 'TEXT');

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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE lower(email)=lower(?)', [email || '']);
    if (!user || !(await bcrypt.compare(password || '', user.password || ''))) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ userId: user.id, role: user.role, fullName: user.fullName }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, name: user.fullName, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use('/api', authenticate);

app.get('/api/auth/me', async (req, res) => {
  const user = await get('SELECT id,email,fullName,role,createdAt FROM users WHERE id=?', [req.user.userId]);
  user ? res.json({ ...user, name: user.fullName }) : res.status(404).json({ error: 'User not found' });
});
app.get('/api/auth/users', requireAdmin, async (req, res) => res.json(await all('SELECT id,email,fullName,role,createdAt FROM users ORDER BY createdAt DESC')));
app.post('/api/auth/register', requireAdmin, async (req, res) => {
  try {
    const { email, password, fullName, role = 'assistant' } = req.body;
    if (!email || !password || !fullName) return res.status(400).json({ error: 'email, password and fullName are required' });
    if (!['advocate', 'assistant', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const id = genId('U');
    const createdAt = new Date().toISOString();
    await run('INSERT INTO users (id,email,password,fullName,role,createdAt) VALUES (?,?,?,?,?,?)', [id, email, await bcrypt.hash(password, 10), fullName, role, createdAt]);
    res.json({ id, email, fullName, name: fullName, role, createdAt });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/auth/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot delete your own account' });
  await run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ id: req.params.id, deleted: true });
});

app.get('/api/dashboard', async (req, res) => {
  const active = await get("SELECT COUNT(*) count FROM matters WHERE stage NOT IN ('Closed','On Hold')");
  const hours = await get("SELECT COALESCE(SUM(hours),0) hours, COALESCE(SUM(hours*rate),0) revenue FROM time_entries WHERE date LIKE ?", [`${today().slice(0, 7)}%`]);
  const overdue = await get('SELECT COUNT(*) count FROM tasks WHERE completed=0 AND dueDate < ?', [today()]);
  const upcomingEvents = await all('SELECT * FROM appearances WHERE date >= ? ORDER BY date LIMIT 5', [today()]);
  res.json({ activeMattersCount: active.count, monthHours: hours.hours, monthRevenue: hours.revenue, overdueTaskCount: overdue.count, upcomingEvents });
});

app.get('/api/clients', async (req, res) => res.json(await all('SELECT * FROM clients ORDER BY name')));
app.post('/api/clients', async (req, res) => {
  const id = genId('C');
  await run('INSERT INTO clients (id,name,type,contact,email,phone,status,joinDate,conflictCleared,retainer) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, req.body.name, req.body.type || 'Individual', req.body.contact || '', req.body.email || '', req.body.phone || '', 'Active', today(), 0, Number(req.body.retainer || 0)]);
  res.json(await get('SELECT * FROM clients WHERE id=?', [id]));
});
app.patch('/api/clients/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['name', 'type', 'contact', 'email', 'phone', 'status', 'conflictCleared', 'retainer'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE clients SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => f === 'retainer' ? Number(req.body[f] || 0) : req.body[f]), req.params.id]);
  const client = await get('SELECT * FROM clients WHERE id=?', [req.params.id]);
  client ? res.json(client) : res.status(404).json({ error: 'Client not found' });
});
app.delete('/api/clients/:id', requireAdvocateOrAdmin, async (req, res) => {
  const matters = await all('SELECT id FROM matters WHERE clientId=?', [req.params.id]);
  await run('BEGIN TRANSACTION');
  try {
    for (const matter of matters) await deleteMatterCascade(matter.id);
    await run('DELETE FROM clients WHERE id=?', [req.params.id]);
    await run('COMMIT');
    res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matters', async (req, res) => res.json(await all('SELECT m.*, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId ORDER BY openDate DESC')));
app.get('/api/matters/:id', async (req, res) => {
  const matter = await get('SELECT m.*, c.name clientName, c.email clientEmail, c.phone clientPhone FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  const [tasks, timeEntries, documents, notes, invoices, appearances] = await Promise.all([
    all('SELECT * FROM tasks WHERE matterId=? ORDER BY dueDate', [req.params.id]),
    all('SELECT * FROM time_entries WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT id,matterId,name,type,mimeType,date,size FROM documents WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id]),
    all('SELECT * FROM invoices WHERE matterId=? ORDER BY date DESC', [req.params.id]),
    all('SELECT * FROM appearances WHERE matterId=? ORDER BY date', [req.params.id])
  ]);
  res.json({ ...matter, tasks, timeEntries, documents, notes, invoices, appearances });
});
app.get('/api/matters/:id/suggestions', async (req, res) => {
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
  res.json(await get('SELECT * FROM matters WHERE id=?', [id]));
});
app.patch('/api/matters/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['reference','clientId','title','practiceArea','stage','assignedTo','paralegal','openDate','description','court','judge','caseNo','opposingCounsel','priority','billingRate','billingType','fixedFee','retainerBalance','totalBilled','solDate'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE matters SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => ['billingRate','fixedFee','retainerBalance','totalBilled'].includes(f) ? Number(req.body[f] || 0) : req.body[f]), req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
  matter ? res.json(matter) : res.status(404).json({ error: 'Matter not found' });
});
app.patch('/api/matters/:id/status', requireAdvocateOrAdmin, async (req, res) => {
  await run('UPDATE matters SET stage=? WHERE id=?', [req.body.stage || 'Closed', req.params.id]);
  const matter = await get('SELECT * FROM matters WHERE id=?', [req.params.id]);
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
  await run('DELETE FROM case_notes WHERE matterId=?', [matterId]);
  await run('DELETE FROM integrations_log WHERE matterId=?', [matterId]);
  await run('DELETE FROM matters WHERE id=?', [matterId]);
}
app.delete('/api/matters/:id', requireAdvocateOrAdmin, async (req, res) => {
  const matter = await get('SELECT id FROM matters WHERE id=?', [req.params.id]);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });
  await run('BEGIN TRANSACTION');
  try {
    await deleteMatterCascade(req.params.id);
    await run('COMMIT');
    res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks', async (req, res) => res.json(await all('SELECT * FROM tasks ORDER BY dueDate')));
app.post('/api/tasks', async (req, res) => { const id = genId('T'); await run('INSERT INTO tasks (id,matterId,title,completed,assignee,dueDate,auto_generated) VALUES (?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.title, req.body.completed ? 1 : 0, req.body.assignee || '', req.body.dueDate || '', 0]); res.json(await get('SELECT * FROM tasks WHERE id=?', [id])); });
app.patch('/api/tasks/:id', requireAdvocateOrAdmin, async (req, res) => { await run('UPDATE tasks SET completed=COALESCE(?,completed), title=COALESCE(?,title), assignee=COALESCE(?,assignee), dueDate=COALESCE(?,dueDate) WHERE id=?', [req.body.completed === undefined ? null : (req.body.completed ? 1 : 0), req.body.title ?? null, req.body.assignee ?? null, req.body.dueDate ?? null, req.params.id]); res.json(await get('SELECT * FROM tasks WHERE id=?', [req.params.id])); });
app.delete('/api/tasks/:id', requireAdvocateOrAdmin, async (req, res) => { await run('DELETE FROM tasks WHERE id=?', [req.params.id]); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/time-entries', async (req, res) => res.json(await all('SELECT * FROM time_entries ORDER BY date DESC')));
app.post('/api/time-entries', async (req, res) => { const id = genId('TIME'); await run('INSERT INTO time_entries (id,matterId,attorney,date,hours,activity,description,rate,billed) VALUES (?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.attorney || req.user.fullName || '', req.body.date || today(), Number(req.body.hours || 0), req.body.activity || '', req.body.description || '', Number(req.body.rate || 0), req.body.billed ? 1 : 0]); res.json(await get('SELECT * FROM time_entries WHERE id=?', [id])); });
app.patch('/api/time-entries/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['matterId','attorney','date','hours','activity','description','rate','billed'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE time_entries SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => ['hours','rate'].includes(f) ? Number(req.body[f] || 0) : f === 'billed' ? (req.body[f] ? 1 : 0) : req.body[f]), req.params.id]);
  const entry = await get('SELECT * FROM time_entries WHERE id=?', [req.params.id]);
  entry ? res.json(entry) : res.status(404).json({ error: 'Time entry not found' });
});
app.delete('/api/time-entries/:id', requireAdvocateOrAdmin, async (req, res) => { await run('DELETE FROM time_entries WHERE id=?', [req.params.id]); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/appearances', async (req, res) => res.json(await all('SELECT * FROM appearances ORDER BY date')));
app.get('/api/appearances/upcoming', async (req, res) => res.json(await all('SELECT * FROM appearances WHERE date>=? ORDER BY date LIMIT 20', [today()])));
app.post('/api/appearances', async (req, res) => { const id = genId('EV'); await run('INSERT INTO appearances (id,matterId,title,date,time,type,location,meetingLink,attorney,prepNote) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, req.body.matterId, req.body.title, req.body.date, req.body.time || '9:00 AM', req.body.type || 'Hearing', req.body.location || '', req.body.meetingLink || '', req.body.attorney || '', req.body.prepNote || '']); res.json(await get('SELECT * FROM appearances WHERE id=?', [id])); });
app.patch('/api/appearances/:id', requireAdvocateOrAdmin, async (req, res) => {
  const fields = ['matterId','title','date','time','type','location','meetingLink','attorney','prepNote'];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'No supported fields supplied' });
  await run(`UPDATE appearances SET ${updates.map(f => `${f}=?`).join(',')} WHERE id=?`, [...updates.map(f => req.body[f]), req.params.id]);
  const event = await get('SELECT * FROM appearances WHERE id=?', [req.params.id]);
  event ? res.json(event) : res.status(404).json({ error: 'Appearance not found' });
});
app.delete('/api/appearances/:id', requireAdvocateOrAdmin, async (req, res) => { await run('DELETE FROM appearances WHERE id=?', [req.params.id]); res.json({ id: req.params.id, deleted: true }); });

app.post('/api/matters/:id/documents', requireAdvocateOrAdmin, async (req, res) => {
  const { name, mimeType, data } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'name and data are required' });
  const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowed.includes(mimeType)) return res.status(400).json({ error: 'Only PDF and Word documents are supported' });
  const id = genId('DOC');
  const buffer = Buffer.from(String(data).split(',').pop(), 'base64');
  await run('INSERT INTO documents (id,matterId,name,type,mimeType,date,size,content) VALUES (?,?,?,?,?,?,?,?)', [id, req.params.id, name.replace(/[^\w .-]/g, '_'), mimeType.includes('pdf') ? 'PDF' : 'Word', mimeType, today(), `${Math.max(1, Math.round(buffer.length / 1024))} KB`, buffer]);
  res.json(await get('SELECT id,matterId,name,type,mimeType,date,size FROM documents WHERE id=?', [id]));
});
app.get('/api/documents/:id/download', async (req, res) => { const doc = await get('SELECT * FROM documents WHERE id=?', [req.params.id]); if (!doc) return res.status(404).json({ error: 'Document not found' }); res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="${doc.name}"`); res.send(doc.content); });
app.delete('/api/documents/:id', requireAdvocateOrAdmin, async (req, res) => { await run('DELETE FROM documents WHERE id=?', [req.params.id]); res.json({ id: req.params.id, deleted: true }); });

app.get('/api/matters/:id/notes', async (req, res) => res.json(await all('SELECT * FROM case_notes WHERE matterId=? ORDER BY createdAt DESC', [req.params.id])));
app.post('/api/matters/:id/notes', async (req, res) => { const id = genId('NOTE'); await run('INSERT INTO case_notes (id,matterId,content,author,createdAt) VALUES (?,?,?,?,?)', [id, req.params.id, req.body.content, req.body.author || req.user.fullName || 'Unknown', new Date().toISOString()]); res.json(await get('SELECT * FROM case_notes WHERE id=?', [id])); });

app.get('/api/invoices', async (req, res) => res.json(await all(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId ORDER BY i.date DESC, i.number DESC`)));
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
    res.json(await invoiceWithDetails(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
async function invoiceWithDetails(id) {
  const invoice = await get(`SELECT i.*, m.title matterTitle, m.reference, c.name clientName, c.email clientEmail, c.phone clientPhone, c.contact clientAddress FROM invoices i LEFT JOIN matters m ON m.id=i.matterId LEFT JOIN clients c ON c.id=i.clientId WHERE i.id=?`, [id]);
  if (!invoice) return null;
  invoice.items = await all('SELECT * FROM invoice_items WHERE invoiceId=? ORDER BY date', [id]);
  return invoice;
}
app.get('/api/invoices/:id', async (req, res) => { const invoice = await invoiceWithDetails(req.params.id); invoice ? res.json(invoice) : res.status(404).json({ error: 'Invoice not found' }); });
app.patch('/api/invoices/:id/status', requireAdmin, async (req, res) => { if (!['Paid', 'Outstanding', 'Overdue'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid invoice status' }); await run('UPDATE invoices SET status=? WHERE id=?', [req.body.status, req.params.id]); res.json(await invoiceWithDetails(req.params.id)); });
app.delete('/api/invoices/:id', requireAdvocateOrAdmin, async (req, res) => {
  const invoice = await get('SELECT * FROM invoices WHERE id=?', [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'Paid') return res.status(400).json({ error: 'Paid invoices cannot be deleted' });
  await run('DELETE FROM invoice_items WHERE invoiceId=?', [req.params.id]);
  await run('DELETE FROM invoices WHERE id=?', [req.params.id]);
  res.json({ id: req.params.id, deleted: true });
});
app.get('/api/invoices/:id/pdf', async (req, res) => {
  const invoice = await invoiceWithDetails(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const subtotal = Number(invoice.amount || 0);
  const vat = subtotal * 0.16;
  const total = subtotal + vat;
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.number || invoice.id}.pdf"`);
  doc.pipe(res);
  doc.rect(48, 42, 52, 52).fill('#1B3A5C');
  doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('LF', 64, 60);
  doc.fillColor('#111827').fontSize(22).text(req.query.firmName || 'LexFlow Kenya', 112, 46);
  doc.fontSize(10).fillColor('#6B7280').font('Helvetica').text('Kenyan Law Practice Management', 112, 74);
  doc.fillColor('#1B3A5C').fontSize(24).font('Helvetica-Bold').text('INVOICE', 400, 48, { align: 'right' });
  doc.moveTo(48, 112).lineTo(547, 112).strokeColor('#E5E7EB').stroke();
  doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text('Bill To', 48, 132);
  doc.font('Helvetica').fillColor('#374151').text(invoice.clientName || 'Client', 48, 150).text(invoice.clientAddress || invoice.clientEmail || invoice.clientPhone || 'Address on file', 48, 166, { width: 230 });
  [['Invoice #', invoice.number], ['Date', invoice.date], ['Due Date', invoice.dueDate], ['Status', invoice.status]].forEach(([label, value], i) => { const y = 132 + i * 18; doc.font('Helvetica-Bold').fillColor('#6B7280').text(label, 350, y); doc.font('Helvetica').fillColor('#111827').text(String(value || ''), 440, y, { width: 105, align: 'right' }); });
  doc.font('Helvetica-Bold').fillColor('#111827').fontSize(11).text('Matter', 48, 220); doc.font('Helvetica').fontSize(10).text(`${invoice.reference || ''} ${invoice.matterTitle || ''}`.trim(), 48, 238, { width: 460 });
  const top = 282; doc.rect(48, top, 499, 24).fill('#F3F4F6'); doc.fillColor('#374151').font('Helvetica-Bold').fontSize(9); doc.text('Date', 56, top + 8); doc.text('Description', 132, top + 8); doc.text('Hours', 330, top + 8, { width: 42, align: 'right' }); doc.text('Rate', 382, top + 8, { width: 70, align: 'right' }); doc.text('Amount', 465, top + 8, { width: 70, align: 'right' });
  let y = top + 36; doc.font('Helvetica').fontSize(9).fillColor('#111827'); for (const item of invoice.items || []) { if (y > 690) { doc.addPage(); y = 60; } doc.text(item.date || invoice.date, 56, y); doc.text(item.description || 'Legal Services', 132, y, { width: 185 }); doc.text(Number(item.hours || 0).toFixed(item.hours ? 2 : 0), 330, y, { width: 42, align: 'right' }); doc.text(money(item.rate), 382, y, { width: 70, align: 'right' }); doc.text(money(item.amount), 465, y, { width: 70, align: 'right' }); y += 24; }
  y = Math.max(y + 24, 610); [['Subtotal', subtotal], ['VAT (16%)', vat], ['Total', total]].forEach(([label, value], i) => { doc.font(i === 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 2 ? 12 : 10).fillColor(i === 2 ? '#1B3A5C' : '#374151'); doc.text(label, 350, y + i * 22); doc.text(money(value), 440, y + i * 22, { width: 105, align: 'right' }); });
  doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text('LexFlow Kenya | Nairobi, Kenya | accounts@lexflow.co.ke | +254 700 123456', 48, 760, { align: 'center', width: 499 });
  doc.end();
});

app.get('/api/search', async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  if (q === '%%') return res.json([]);
  const matters = await all(`SELECT m.id,m.title,m.reference,c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.title LIKE ? OR m.reference LIKE ? OR c.name LIKE ? LIMIT 15`, [q, q, q]);
  const clients = await all('SELECT id,name,email,phone FROM clients WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 15', [q, q, q]);
  res.json([...matters.map(m => ({ type: 'Matter', id: m.id, matterId: m.id, title: m.title, subtitle: `${m.reference || ''} ${m.clientName || ''}`.trim() })), ...clients.map(c => ({ type: 'Client', id: c.id, title: c.name, subtitle: `${c.email || ''} ${c.phone || ''}`.trim() }))]);
});

app.post('/api/mpesa/stk-push', async (req, res) => { const id = genId('MPESA'); await run('INSERT INTO integrations_log (id,type,matterId,clientId,recipient,message,status,createdAt) VALUES (?,?,?,?,?,?,?,?)', [id, 'mpesa', req.body.matterId || '', req.body.clientId || '', req.body.phone || '', `STK push amount ${req.body.amount}`, 'Queued', new Date().toISOString()]); res.json({ id, status: 'Queued', checkoutRequestId: `ws_CO_${Date.now()}`, message: 'STK push queued. Add Daraja credentials for live payments.' }); });
app.post('/api/whatsapp/reminders', async (req, res) => { const rows = await all(`SELECT a.*,m.clientId,m.title matterTitle,c.name clientName,c.phone FROM appearances a LEFT JOIN matters m ON m.id=a.matterId LEFT JOIN clients c ON c.id=m.clientId WHERE a.date BETWEEN ? AND ?`, [today(), addDays(Number(req.body.days || 3))]); const reminders = rows.map(r => ({ id: genId('WA'), matterId: r.matterId, clientName: r.clientName, phone: r.phone, message: `Reminder: ${r.title} for ${r.matterTitle} is on ${r.date} at ${r.time || 'TBA'}.`, status: r.phone ? 'Queued' : 'Missing phone' })); res.json({ count: reminders.length, reminders }); });
app.get('/api/exports/:type.:format', async (req, res) => { const rows = req.params.type === 'itax' ? await all(`SELECT i.number,i.date,c.name client,i.amount,i.status FROM invoices i LEFT JOIN clients c ON c.id=i.clientId`) : await all(`SELECT m.reference,m.title,c.name client,m.practiceArea,m.stage,m.totalBilled FROM matters m LEFT JOIN clients c ON c.id=m.clientId`); if (req.params.format === 'pdf') { const doc = new PDFDocument(); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-report.pdf"`); doc.pipe(res); doc.fontSize(18).text(`${req.params.type.toUpperCase()} Report`); rows.forEach(r => doc.fontSize(10).text(Object.values(r).join(' | '))); doc.end(); } else { res.setHeader('Content-Type', 'application/vnd.ms-excel'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-report.xls"`); res.send(rows.map(r => Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')); } });

initDb().then(() => {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`LexFlow Kenya server running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('Database initialisation failed', err);
  process.exit(1);
});
