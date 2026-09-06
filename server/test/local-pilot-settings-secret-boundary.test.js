const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

// This suite owns its database and never loads the local pilot .env.
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
const mockWhatsApp = jest.fn().mockResolvedValue({ sid: 'synthetic-message' });
const mockEmail = jest.fn().mockResolvedValue({ messageId: 'synthetic-message' });
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: mockWhatsApp } })));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: mockEmail })) }));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-settings-100a-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(tempDir, 'settings.db');
process.env.JWT_SECRET = 'synthetic-settings-100a-jwt-signing-key';
fs.writeFileSync(process.env.DATABASE_PATH, '');
const output = [];
const spies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation((...args) => output.push(util.format(...args))));
const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server');
const { signAccessToken } = require('../lib/tokens');
const createDb = require('../lib/db');
const createReminders = require('../lib/reminders');
const { CLIENT_FIELDS, STAFF_FIELDS, REMINDER_FIELDS, serializeFirmSettings } = require('../lib/firmSettingsSerialization');

const markers = ['SYNTHETIC-100A-TWILIO-ORIGINAL', 'SYNTHETIC-100A-SMTP-ORIGINAL', 'SYNTHETIC-100A-TWILIO-REPLACEMENT', 'SYNTHETIC-100A-SMTP-REPLACEMENT', 'SYNTHETIC-100A-OPAQUE-SECRET'];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const safeFirm = {
  name: 'Boundary Test Firm', logo: png, letterhead: png,
  primaryColor: '#1A3628', accentColor: '#C5973C', websiteURL: 'https://example.test',
  email: 'firm@example.test', phone: '+254700000000', address: 'Test Nairobi',
  paymentInstructions: 'Pay test account 100A using the invoice number.',
  kraPin: 'TEST-PIN', vatNumber: 'TEST-VAT', invoiceFooterNote: 'Test terms',
  defaultInvoiceDueDays: 14, advocateBillingVisibility: 0,
  moduleSettings: { retainerManagement: true, clientTasks: true },
};
const providerConfig = {
  remindersEnabled: true, whatsappEnabled: true, emailEnabled: true,
  twilioSid: 'AC-synthetic-100a', twilioFromNumber: 'whatsapp:+10000000000',
  smtpHost: 'smtp.example.test', smtpPort: '587', smtpUser: 'sender@example.test',
};
let sql;
let database;
let reminders;
const tokens = {};
const responses = [];
function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const marker of markers) expect(text.includes(marker)).toBe(false);
}
async function call(method, url, role, body) {
  let req = request(app)[method](url);
  if (role) req = req.set('Authorization', `Bearer ${tokens[role]}`);
  if (body !== undefined) req = req.send(body);
  const response = await req;
  responses.push(response.text);
  assertNoSecrets(response.text);
  return response;
}
const save = body => call('put', '/api/firm-settings', 'admin', body);
const stored = () => sql.get('SELECT * FROM reminder_settings WHERE id=?', ['default']);

beforeAll(async () => {
  await dbReady;
  database = new sqlite3.Database(process.env.DATABASE_PATH);
  sql = createDb(database);
  for (const role of ['client', 'advocate', 'assistant', 'admin']) {
    const user = { id: `boundary-${role}`, email: `${role}@example.test`, fullName: `Test ${role}`, role, tokenVersion: 0 };
    await sql.run('INSERT INTO users (id,email,password,fullName,role,tokenVersion) VALUES (?,?,?,?,?,?)', [user.id, user.email, 'unused-test-password-hash', user.fullName, role, 0]);
    tokens[role] = signAccessToken(user);
  }
  reminders = createReminders({ ...sql, genId: prefix => `${prefix}-${Math.random()}`, money: String, defaultFirmSettings: safeFirm });
  expect((await save({ ...safeFirm, reminderSettings: { ...providerConfig, twilioToken: markers[0], smtpPass: markers[1] } })).status).toBe(200);
  const current = await sql.get('SELECT themeJson FROM firm_settings WHERE id=?', ['default']);
  await sql.run('UPDATE firm_settings SET themeJson=?, moduleSettingsJson=? WHERE id=?', [
    JSON.stringify({ ...JSON.parse(current.themeJson), password: markers[4], internal: { clientSecret: markers[4] } }),
    JSON.stringify({ ...safeFirm.moduleSettings, encryptionKey: markers[4] }), 'default',
  ]);
});

afterAll(async () => {
  spies.forEach(spy => spy.mockRestore());
  if (database) await new Promise((resolve, reject) => database.close(err => err ? reject(err) : resolve()));
  // The app owns additional SQLite handles until Jest exits. The disposable
  // database stays in the OS temp directory; no pilot files are touched.
});

test('unauthenticated settings and theme requests are protected', async () => {
  for (const url of ['/api/firm-settings', '/api/firm-settings/theme', '/api/firm-settings/theme/presets']) {
    expect((await call('get', url)).status).toBe(401);
  }
  expect((await call('put', '/api/firm-settings', null, { reminderSettings: { twilioToken: markers[2] } })).status).toBe(401);
});

test.each(['client', 'advocate', 'assistant', 'admin'])('%s receives exactly its safe response tier', async role => {
  const response = await call('get', '/api/firm-settings', role);
  expect(response.status).toBe(200);
  const staff = role !== 'client';
  const keys = [...(staff ? STAFF_FIELDS : CLIENT_FIELDS), 'theme', ...(staff ? ['moduleSettings'] : []), ...(role === 'admin' ? ['reminderSettings'] : [])];
  expect(Object.keys(response.body).sort()).toEqual(keys.sort());
  expect(response.body.paymentInstructions).toBe(safeFirm.paymentInstructions);
  expect(response.body.theme.primaryColor).toBe(safeFirm.primaryColor);
  if (staff) {
    expect(response.body.letterhead).toBe(png);
    expect(response.body.theme.letterhead).toBe(png);
    expect(response.body.moduleSettings).toMatchObject(safeFirm.moduleSettings);
    expect(response.body.advocateBillingVisibility).toBe(0);
    expect(response.body.kraPin).toBe(safeFirm.kraPin);
  }
  if (role === 'admin') {
    expect(Object.keys(response.body.reminderSettings).sort()).toEqual([...REMINDER_FIELDS, 'twilioTokenConfigured', 'smtpPassConfigured'].sort());
    expect(response.body.reminderSettings).toMatchObject({ ...providerConfig, twilioTokenConfigured: true, smtpPassConfigured: true });
  }
  expect((await call('get', '/api/firm-settings/theme', role)).status).toBe(200);
});

test('future database fields and nested opaque JSON are excluded by allowlists', () => {
  const hostile = { ...safeFirm, password: markers[4], providerToken: markers[4], apiSecret: markers[4], clientSecret: markers[4], encryptionKey: markers[4], authenticationSecret: markers[4], themeJson: markers[4], moduleSettingsJson: markers[4], theme: { primaryColor: '#1A3628', smtpPass: markers[1], internal: { secret: markers[4] } }, moduleSettings: { retainerManagement: true, internal: markers[4] } };
  for (const role of ['client', 'advocate', 'assistant', 'admin', 'unknown']) assertNoSecrets(serializeFirmSettings(hostile, role, { ...providerConfig, twilioToken: markers[0], smtpPass: markers[1], opaque: markers[4] }));
});

test('public branding keeps the existing public allowlist', async () => {
  const response = await call('get', '/api/public/branding');
  expect(response.status).toBe(200);
  expect(Object.keys(response.body).sort()).toEqual(['name', 'firmName', 'displayName', 'appName', 'productName', 'poweredBy', 'logo', 'primaryColor', 'accentColor', 'theme'].sort());
  expect(response.body.theme).not.toHaveProperty('letterhead');
  expect(response.body).not.toHaveProperty('email');
});

test.each(['client', 'advocate', 'assistant'])('%s cannot update settings or credentials', async role => {
  expect((await call('put', '/api/firm-settings', role, { reminderSettings: { twilioToken: markers[2], smtpPass: null } })).status).toBe(403);
  expect(await stored()).toMatchObject({ twilioToken: markers[0], smtpPass: markers[1] });
});

test('ordinary saves, omitted secrets, empty inputs and status indicators preserve credentials', async () => {
  const current = (await call('get', '/api/firm-settings', 'admin')).body;
  for (const payload of [
    { ...current, phone: '+254711000000' },
    { ...current, reminderSettings: { emailEnabled: false } },
    { ...current, reminderSettings: { twilioToken: '', smtpPass: '', twilioTokenConfigured: false, smtpPassConfigured: false } },
    { name: safeFirm.name },
  ]) {
    expect((await save(payload)).status).toBe(200);
    expect(await stored()).toMatchObject({ twilioToken: markers[0], smtpPass: markers[1], twilioSid: providerConfig.twilioSid, smtpHost: providerConfig.smtpHost });
  }
});

test('replacement changes only supplied credentials; null explicitly clears each credential', async () => {
  expect((await save({ ...safeFirm, reminderSettings: { twilioToken: markers[2] } })).status).toBe(200);
  expect(await stored()).toMatchObject({ twilioToken: markers[2], smtpPass: markers[1] });
  expect((await save({ ...safeFirm, reminderSettings: { smtpPass: markers[3] } })).status).toBe(200);
  expect(await stored()).toMatchObject({ twilioToken: markers[2], smtpPass: markers[3] });
  const clearTwilio = await save({ ...safeFirm, reminderSettings: { twilioToken: null } });
  expect(clearTwilio.body.reminderSettings).toMatchObject({ twilioTokenConfigured: false, smtpPassConfigured: true });
  expect(await stored()).toMatchObject({ twilioToken: '', smtpPass: markers[3] });
  const clearSmtp = await save({ ...safeFirm, reminderSettings: { smtpPass: null } });
  expect(clearSmtp.body.reminderSettings).toMatchObject({ twilioTokenConfigured: false, smtpPassConfigured: false });
  expect(await stored()).toMatchObject({ twilioToken: '', smtpPass: '' });
});

test.each(['********', { value: markers[4] }, 123, false])('invalid credential input is rejected before any settings write (%#)', async value => {
  const before = await stored();
  expect((await save({ name: 'Must not save', reminderSettings: { twilioToken: value } })).status).toBe(400);
  expect(await stored()).toEqual(before);
  expect((await call('get', '/api/firm-settings', 'admin')).body.name).toBe(safeFirm.name);
});

test('theme preview/save/reset and Document Studio letterhead preserve the boundary', async () => {
  const theme = { source: 'manual', primaryColor: '#1A3628', accentColor: '#C5973C' };
  expect((await call('post', '/api/firm-settings/theme/preview', 'admin', theme)).status).toBe(200);
  expect((await call('put', '/api/firm-settings/theme', 'admin', theme)).status).toBe(200);
  expect((await call('post', '/api/firm-settings/theme/reset', 'admin', {})).status).toBe(200);
  expect((await call('get', '/api/firm-settings', 'advocate')).body.letterhead).toBe(png);
});

test('reminder execution reads real stored synthetic credentials through its private helper', async () => {
  expect((await save({ ...safeFirm, reminderSettings: { ...providerConfig, twilioToken: markers[2], smtpPass: markers[3] } })).status).toBe(200);
  expect(await reminders.getReminderSettingsInternal()).toMatchObject({ twilioToken: markers[2], smtpPass: markers[3] });
  const context = { client: { id: 'boundary-client', name: 'Test Client', phone: '+10000000001', email: 'recipient@example.test' }, matter: { id: 'boundary-matter', title: 'Test Matter' } };
  const safeReader = async () => (await call('get', '/api/firm-settings', 'admin')).body;
  await reminders.sendReminder('invoice_overdue', context, safeReader);
  expect(require('twilio')).toHaveBeenCalledWith(providerConfig.twilioSid, markers[2]);
  expect(require('nodemailer').createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: { user: providerConfig.smtpUser, pass: markers[3] } }));
  expect(mockWhatsApp).toHaveBeenCalledTimes(1);
  expect(mockEmail).toHaveBeenCalledTimes(1);
  mockWhatsApp.mockRejectedValueOnce(new Error(`Synthetic provider rejected ${markers[2]}`));
  mockEmail.mockRejectedValueOnce(new Error(`Synthetic provider rejected ${markers[3]}`));
  await reminders.sendReminder('invoice_overdue', context, safeReader);
  const logs = await sql.all('SELECT * FROM reminder_logs');
  expect(logs.filter(row => row.status === 'sent')).toHaveLength(2);
  expect(logs.filter(row => row.status === 'failed')).toHaveLength(2);
  assertNoSecrets(logs);
});

test('all tested responses, audit APIs, persisted logs and captured console output omit synthetic secrets', async () => {
  for (const url of ['/api/audit-logs', '/api/audit-events?action=firm_settings_updated', '/api/reminder-logs']) {
    expect((await call('get', url, 'admin')).status).toBe(200);
  }
  for (const table of ['audit_logs', 'audit_events', 'reminder_logs']) assertNoSecrets(await sql.all(`SELECT * FROM ${table}`));
  assertNoSecrets(output);
  assertNoSecrets(responses);
});
