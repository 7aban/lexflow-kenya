const fs = require('fs');
const os = require('os');
const path = require('path');
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-client-matter-100b-signing-key';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-100b-')), 'boundary.db');
fs.writeFileSync(process.env.DATABASE_PATH, '');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server');
const createDb = require('../lib/db');
const createAccess = require('../lib/access');
const { signAccessToken } = require('../lib/tokens');
jest.setTimeout(30000);

let db, sql, access;
const users = {};
const tokens = {};
const modules = { retainerManagement: true, kycCdd: true, corporateAuthority: true, retainerLedger: true, scopeVariation: true };
const insert = (table, row) => sql.run(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
function api(role, method, url, body) {
  let req = request(app)[method](`/api${url}`);
  if (role) req = req.set('Authorization', `Bearer ${tokens[role]}`);
  return body === undefined ? req : req.send(body);
}
const ids = response => response.body.map(row => row.id).sort();
async function state() {
  const tables = await sql.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const result = {};
  for (const { name } of tables) {
    result[name] = await sql.all(`SELECT * FROM ${name}${name === 'audit_events' ? " WHERE action NOT LIKE 'forbidden_%'" : ''} ORDER BY rowid`);
  }
  return JSON.stringify(result);
}
async function denied(role, method, url, body, status = 403) {
  const before = await state();
  const response = await api(role, method, url, body);
  expect(response.status).toBe(status);
  expect(await state()).toBe(before);
  return response;
}

beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(process.env.DATABASE_PATH);
  sql = createDb(db);
  access = createAccess(sql);
  for (const [key, role, fullName, clientId] of [
    ['admin', 'admin', 'Boundary Admin', ''], ['assistant', 'assistant', 'Boundary Assistant', ''],
    ['a', 'advocate', 'Advocate A', ''], ['b', 'advocate', 'Advocate B', ''],
    ['client', 'client', 'Shared Portal', 'shared'], ['otherClient', 'client', 'Other Portal', 'other'],
  ]) {
    users[key] = { id: `USER-${key}`, role, fullName, clientId, tokenVersion: 1 };
    await insert('users', { ...users[key], email: `${key}@example.test`, password: 'synthetic-unused-hash', isActive: 1 });
    tokens[key] = signAccessToken(users[key]);
  }
  for (const id of ['shared', 'only-a', 'only-b', 'intake', 'other']) await insert('clients', { id, name: `Client ${id}`, email: `${id}@example.test`, conflictCleared: 1, status: 'Active' });
  for (const [id, clientId, assignedTo] of [['A1', 'shared', 'Advocate A'], ['B1', 'shared', 'Advocate B'], ['A2', 'only-a', 'Advocate A'], ['B2', 'only-b', 'Advocate B'], ['OTHER', 'other', 'Advocate B']]) {
    await insert('matters', { id, clientId, assignedTo, title: `Matter ${id}`, reference: `100B-${id}`, stage: 'Intake', openDate: '2026-01-01' });
  }
  await insert('firm_settings', { id: 'default', name: 'Boundary Firm', advocateBillingVisibility: 1, moduleSettingsJson: JSON.stringify(modules) });
  for (const [matterId, prefix, amount, createdAt] of [['A1', 'A', 100, '2026-01-01'], ['B1', 'HIDDEN-100B', 98765, '2099-01-01'], [null, 'UNLINKED-100B', 54321, '2099-02-01']]) {
    const clientId = 'shared';
    await insert('deadlines', { id: `${prefix}-DL`, clientId, matterId, title: `${prefix} deadline`, dueDate: prefix === 'A' ? '2099-12-31' : '2099-01-01', status: 'Open' });
    await insert('document_requests', { id: `${prefix}-DR`, clientId, matterId: matterId || '', staffUserId: users.admin.id, title: `${prefix} request`, description: '', status: 'pending', createdAt });
    await insert('invoices', { id: `${prefix}-INV`, clientId, matterId: matterId || '', number: `${prefix}-INV`, amount, status: 'Outstanding', dueDate: '2020-01-01' });
    await insert('payment_proofs', { id: `${prefix}-PROOF`, clientId, matterId, invoiceId: `${prefix}-INV`, status: 'Pending', amount, createdAt });
    await insert('client_activity', { id: `${prefix}-ACT`, clientId, matterId, userId: users.admin.id, action: 'view', summary: `${prefix} activity`, createdAt });
    await insert('retainer_records', { id: `${prefix}-RET`, clientId, matterId, status: 'draft', isActive: 1, createdBy: users.admin.id, createdAt });
    if (matterId) {
      await insert('matter_fee_plans', { id: `${prefix}-FEE`, clientId, matterId, feeType: 'fixed', estimatedAmount: amount, status: 'draft', createdBy: users.admin.id, createdAt });
      await insert('appearances', { id: `${prefix}-AP`, matterId, title: `${prefix} appearance`, date: prefix === 'A' ? '2099-12-31' : '2099-01-01', time: '09:00', attorney: prefix === 'A' ? 'Advocate A' : 'Advocate B' });
      for (let index = 0; index < (prefix === 'A' ? 2 : 7); index++) await insert('documents', { id: `${prefix}-DOC-${index}`, matterId, name: `${prefix} document ${index}.pdf`, type: 'pdf', mimeType: 'application/pdf', date: createdAt, content: Buffer.from('SYNTHETIC-100B-DOCUMENT-BYTES'), source: 'firm', clientVisible: index === 0 ? 1 : 0 });
    }
    await insert('retainer_ledger_entries', { id: `${prefix}-LEDGER`, clientId, matterId, entryType: 'deposit', direction: 'credit', amount, currency: 'KES', entryDate: '2026-01-01', createdBy: users.admin.id, createdAt });
    await insert('retainer_lifecycle_events', { id: `${prefix}-LIFE`, clientId, matterId, eventType: 'scope_variation', status: 'pending', title: `${prefix} lifecycle`, createdBy: users.admin.id, createdAt });
  }
  await insert('payment_proofs', { id: 'CROSS-LINKED-PROOF', clientId: 'shared', matterId: 'A1', invoiceId: 'HIDDEN-100B-INV', status: 'Pending', amount: 98765 });
  for (const clientId of ['shared', 'only-b']) {
    await insert('client_kyc_records', { id: `${clientId}-KYC`, clientId, status: 'verified', clientCategory: 'individual', createdBy: users.admin.id, createdAt: '2026-01-01' });
    await insert('client_authority_records', { id: `${clientId}-AUTH`, clientId, status: 'confirmed', createdBy: users.admin.id, createdAt: '2026-01-01' });
  }
  await insert('tasks', { id: 'DELEGATED-TASK', matterId: 'B2', title: 'Delegated work', assignee: 'Advocate A' });
  await insert('appearances', { id: 'DELEGATED-AP', matterId: 'B2', title: 'Delegated appearance', attorney: 'Advocate A', date: '2099-01-01' });
});
afterAll(async () => { if (db) await new Promise(resolve => db.close(resolve)); });

test('unauthenticated client and matter entry points reject reads and writes', async () => {
  for (const url of ['/clients', '/clients/shared/activity', '/clients/shared/snapshot', '/matters?clientId=shared', '/matters/A1']) expect((await api(null, 'get', url)).status).toBe(401);
  for (const [method, url, body] of [['post', '/clients', { name: 'Blocked' }], ['patch', '/clients/shared', { name: 'Blocked' }], ['delete', '/clients/shared'], ['post', '/matters', { clientId: 'shared', title: 'Blocked' }], ['patch', '/matters/A1', { title: 'Blocked' }]]) await denied(null, method, url, body, 401);
});
test.each([['a', ['only-a', 'shared']], ['b', ['only-b', 'other', 'shared']], ['admin', ['intake', 'only-a', 'only-b', 'other', 'shared']], ['assistant', ['intake', 'only-a', 'only-b', 'other', 'shared']]])('%s client listing follows its exact scope', async (role, expected) => {
  const response = await api(role, 'get', '/clients');
  expect(response.status).toBe(200);
  expect(ids(response)).toEqual(expected);
});
test('delegated tasks and appearances do not grant a client or matter', async () => {
  const req = { user: users.a };
  expect(await access.canAccessTask(req, 'DELEGATED-TASK')).toBe(true);
  expect(await access.canAccessAppearance(req, 'DELEGATED-AP')).toBe(true);
  expect(await access.canAccessMatter(req, 'B2')).toBe(false);
  expect(await access.canAccessClient(req, 'only-b')).toBe(false);
  for (const url of ['/clients/only-b/activity', '/clients/only-b/snapshot', '/matters/B2']) expect((await api('a', 'get', url)).status).toBe(403);
});
test.each([['a', ['A1']], ['b', ['B1']], ['admin', ['A1', 'B1']], ['assistant', ['A1', 'B1']]])('%s client-filtered matter list intersects matter scope', async (role, expected) => {
  expect(ids(await api(role, 'get', '/matters?clientId=shared'))).toEqual(expected);
});
test('advocate matter filters cannot expose inaccessible or delegated matters', async () => {
  expect(ids(await api('a', 'get', '/matters?clientId=only-b'))).toEqual([]);
  expect(ids(await api('a', 'get', '/matters'))).toEqual(['A1', 'A2']);
  expect((await api('a', 'get', '/matters/B1')).status).toBe(403);
});
test('client activity authorizes the client and scopes rows before LIMIT', async () => {
  expect(ids(await api('a', 'get', '/clients/shared/activity?limit=1'))).toEqual(['A-ACT']);
  expect(ids(await api('b', 'get', '/clients/shared/activity?limit=1'))).toEqual(['HIDDEN-100B-ACT']);
  expect((await api('a', 'get', '/clients/intake/activity')).status).toBe(403);
  expect((await api('admin', 'get', '/clients/shared/activity')).body).toHaveLength(3);
  expect((await api('assistant', 'get', '/clients/shared/activity')).body).toHaveLength(3);
});
test('shared-client snapshot scopes every matter child before aggregation and selection', async () => {
  const response = await api('a', 'get', '/clients/shared/snapshot');
  expect(response.status).toBe(200);
  const snapshot = response.body;
  expect(snapshot.matters).toMatchObject({ activeCount: 1, totalCount: 1, nextAppearance: { id: 'A-AP', matterId: 'A1' } });
  expect(snapshot.obligations).toMatchObject({ openDeadlinesCount: 1, pendingDocumentRequestsCount: 1, nextDeadline: { id: 'A-DL' } });
  expect(snapshot.billing).toEqual({ visible: true, outstandingBalance: 100, overdueInvoiceCount: 1, pendingPaymentProofCount: 1 });
  expect(snapshot.recentDocuments.map(row => row.id).sort()).toEqual(['A-DOC-0', 'A-DOC-1']);
  expect(snapshot.retainer).toMatchObject({ activeCount: 1, latest: { id: 'A-RET' } });
  expect(snapshot.feePlan).toMatchObject({ activeCount: 1, latest: { id: 'A-FEE', estimatedAmount: 100 } });
  expect(snapshot.ledger).toMatchObject({ entryCount: 1, balance: 100 });
  expect(snapshot.lifecycle).toMatchObject({ activeCount: 1, latest: { id: 'A-LIFE' }, summary: { scope_variation: 1, pending: 1 } });
  // KYC and authority have no matterId: their existing explicit client-level
  // access remains, with safe metadata only and independent client scope.
  expect(snapshot.kyc).toMatchObject({ activeCount: 1, latest: { id: 'shared-KYC' } });
  expect(snapshot.authority).toMatchObject({ activeCount: 1, latest: { id: 'shared-AUTH' } });
  expect(JSON.stringify(snapshot)).not.toMatch(/HIDDEN-100B|UNLINKED-100B|only-b|SYNTHETIC-100B-DOCUMENT-BYTES|98765|54321/);
  const other = await api('b', 'get', '/clients/shared/snapshot');
  expect(other.body.billing.outstandingBalance).toBe(98765);
  expect(other.body.recentDocuments).toHaveLength(5);
  expect(other.body.recentDocuments.every(doc => doc.matterId === 'B1')).toBe(true);
});
test.each(['admin', 'assistant'])('%s retains firm-wide shared-client snapshot and unlinked records', async role => {
  const snapshot = (await api(role, 'get', '/clients/shared/snapshot')).body;
  expect(snapshot.matters.totalCount).toBe(2);
  expect(snapshot.obligations.openDeadlinesCount).toBe(3);
  expect(snapshot.billing).toMatchObject({ outstandingBalance: 153186, pendingPaymentProofCount: 4 });
  expect(snapshot.retainer.activeCount).toBe(3);
  expect(snapshot.feePlan.activeCount).toBe(2);
  expect(snapshot.ledger.entryCount).toBe(3);
  expect(snapshot.lifecycle.activeCount).toBe(3);
});
test('snapshot billing masking also hides monetary module summaries', async () => {
  await sql.run('UPDATE firm_settings SET advocateBillingVisibility=0');
  try {
    const snapshot = (await api('a', 'get', '/clients/shared/snapshot')).body;
    expect(snapshot.billing).toEqual({ visible: false, outstandingBalance: null, overdueInvoiceCount: null, pendingPaymentProofCount: null });
    expect(snapshot.feePlan).toEqual({ visible: false });
    expect(snapshot.ledger).toEqual({ visible: false });
    expect(snapshot.attentionFlags.some(flag => ['overdue_invoices', 'unpaid_fees', 'pending_payment_proof'].includes(flag.key))).toBe(false);
    expect((await api('admin', 'get', '/clients/shared/snapshot')).body.billing.visible).toBe(true);
  } finally { await sql.run('UPDATE firm_settings SET advocateBillingVisibility=1'); }
});
test('document bytes and own-portal isolation stay independently authorized', async () => {
  expect((await api('a', 'get', '/documents/A-DOC-0/download')).status).toBe(200);
  expect((await api('a', 'get', '/documents/HIDDEN-100B-DOC-0/download')).status).toBe(403);
  expect((await api('client', 'get', '/documents/A-DOC-0/download')).status).toBe(200);
  expect((await api('client', 'get', '/documents/A-DOC-1/download')).status).toBe(403);
  expect((await api('otherClient', 'get', '/documents/A-DOC-0/download')).status).toBe(403);
  expect(ids(await api('client', 'get', '/matters?clientId=other'))).toEqual(['A1', 'B1']);
  expect((await api('client', 'get', '/matters/OTHER')).status).toBe(403);
  for (const role of ['client', 'otherClient']) for (const url of ['/clients', '/clients/shared/activity', '/clients/shared/snapshot']) expect((await api(role, 'get', url)).status).toBe(403);
});
test.each(['a', 'b', 'assistant', 'client'])('%s cannot cascade-delete a shared client; no mutation or success audit', async role => {
  await denied(role, 'delete', '/clients/shared');
});
test.each(['a', 'assistant', 'client'])('%s cannot mutate an inaccessible client', async role => {
  await denied(role, 'patch', '/clients/only-b', { name: 'Rejected name', retainer: 9999 });
});
test('an advocate can edit an accessible client; admin can edit any client', async () => {
  expect((await api('a', 'patch', '/clients/shared', { contact: 'Authorized contact' })).status).toBe(200);
  expect((await api('admin', 'patch', '/clients/intake', { contact: 'Admin intake contact' })).status).toBe(200);
});
test.each(['a', 'assistant', 'client'])('%s cannot create a matter for an inaccessible existing client', async role => {
  await denied(role, 'post', '/matters', { clientId: 'only-b', title: 'Unauthorized matter', assignedTo: 'Advocate A' });
});
test('advocate creates self-assigned matters only for an accessible client', async () => {
  const response = await api('a', 'post', '/matters', { clientId: 'shared', title: 'Authorized new matter' });
  expect(response.status).toBe(200);
  expect(response.body.assignedTo).toBe('Advocate A');
  await denied('a', 'post', '/matters', { clientId: 'shared', title: 'Rejected assignment', assignedTo: 'Advocate B' });
});
test('advocate and assistant intake is preserved through an explicit admin first-matter handoff', async () => {
  for (const role of ['a', 'assistant']) {
    const client = await api(role, 'post', '/clients', { name: `Intake by ${role}` });
    expect(client.status).toBe(200);
    await denied('a', 'post', '/matters', { clientId: client.body.id, title: 'Premature first matter' });
    expect(ids(await api('a', 'get', '/clients'))).not.toContain(client.body.id);
    expect(ids(await api('assistant', 'get', '/clients'))).toContain(client.body.id);
    const matter = await api('admin', 'post', '/matters', { clientId: client.body.id, title: `Admin handoff ${role}`, assignedTo: 'Advocate A' });
    expect(matter.status).toBe(200);
    expect(ids(await api('a', 'get', '/clients'))).toContain(client.body.id);
    expect((await api('a', 'get', `/clients/${client.body.id}/snapshot`)).status).toBe(200);
  }
});
test.each([
  ['a', 'A1', { clientId: 'only-b', title: 'Rejected' }, 403],
  ['a', 'A1', { clientId: 'only-a' }, 403],
  ['a', 'A1', { assignedTo: 'Advocate B', stage: 'Closed' }, 403],
  ['a', 'A1', { assignedTo: '' }, 403],
  ['a', 'B1', { clientId: 'only-a', assignedTo: 'Advocate A' }, 403],
  ['assistant', 'A1', { title: 'Rejected support edit' }, 403],
  ['assistant', 'A1', { clientId: 'only-b', assignedTo: 'Advocate B' }, 403],
  ['client', 'A1', { title: 'Rejected portal edit' }, 403],
  ['admin', 'A1', { assignedTo: 'Advocate B' }, 400],
  ['admin', 'A1', { clientId: 'missing-client' }, 400],
])('generic PATCH association boundary (%#)', async (role, id, body, status) => { await denied(role, 'patch', `/matters/${id}`, body, status); });
test('ordinary advocate matter edit with unchanged associations remains valid', async () => {
  const response = await api('a', 'patch', '/matters/A1', { clientId: 'shared', assignedTo: 'Advocate A', title: 'Updated own matter' });
  expect(response.status).toBe(200);
  expect(response.body.title).toBe('Updated own matter');
});
test('admin can reassociate an existing matter to a valid destination client', async () => {
  const response = await api('admin', 'patch', '/matters/A2', { clientId: 'shared' });
  expect(response.status).toBe(200);
  expect(response.body.clientId).toBe('shared');
  expect((await api('admin', 'patch', '/matters/A2', { clientId: 'only-a' })).status).toBe(200);
});
test('dedicated admin reassignment transfers client and matter visibility without delegation grants', async () => {
  await denied('a', 'patch', '/matters/A2/reassign', { assignedTo: 'Advocate B' });
  await denied('assistant', 'patch', '/matters/A2/reassign', { assignedTo: 'Advocate B' });
  const response = await api('admin', 'patch', '/matters/A2/reassign', { assignedTo: 'Advocate B' });
  expect(response.status).toBe(200);
  expect(ids(await api('a', 'get', '/clients'))).not.toContain('only-a');
  expect(ids(await api('b', 'get', '/clients'))).toContain('only-a');
  expect((await api('a', 'get', '/matters/A2')).status).toBe(403);
  expect((await api('b', 'get', '/matters/A2')).status).toBe(200);
  expect((await sql.get("SELECT COUNT(*) count FROM audit_events WHERE action='matter_reassigned' AND entity_id='A2'")).count).toBe(1);
});
test('admin cascade deletion stays available for a disposable client and matter', async () => {
  const client = await api('admin', 'post', '/clients', { name: 'Disposable admin delete' });
  const matter = await api('admin', 'post', '/matters', { clientId: client.body.id, title: 'Disposable admin matter' });
  expect(matter.status).toBe(200);
  expect((await api('admin', 'delete', `/clients/${client.body.id}`)).status).toBe(200);
  expect(await sql.get('SELECT id FROM clients WHERE id=?', [client.body.id])).toBeUndefined();
  expect(await sql.get('SELECT id FROM matters WHERE id=?', [matter.body.id])).toBeUndefined();
});
