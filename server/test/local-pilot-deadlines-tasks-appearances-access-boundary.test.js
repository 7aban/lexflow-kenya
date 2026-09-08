const fs = require('fs'), os = require('os'), path = require('path');
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-workflow-100d-signing-key';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-100d-')), 'boundary.db');
fs.writeFileSync(process.env.DATABASE_PATH, '');
const request = require('supertest'), sqlite3 = require('sqlite3');
const { app, dbReady } = require('../server');
const { signAccessToken } = require('../lib/tokens');
const users = {}, tokens = {};
let db, sql, access;
const date = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const insert = (table, row) => sql.run(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
function api(role, method, url, body) {
  let req = request(app)[method](`/api${url}`);
  if (role) req = req.set('Authorization', `Bearer ${tokens[role]}`);
  return body === undefined ? req : req.send(body);
}
async function read(role, url) { const res = await api(role, 'get', url); expect(res.status).toBe(200); return res.body; }
async function ids(role, url) { return (await read(role, url)).map(r => r.id).sort(); }
async function state() {
  const result = {};
  for (const { name } of await sql.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    result[name] = await sql.all(`SELECT * FROM ${name}${name === 'audit_events' ? " WHERE action NOT LIKE 'forbidden_%'" : ''} ORDER BY rowid`);
  }
  return JSON.stringify(result);
}
async function denied(role, method, url, body, status = 403) {
  const before = await state();
  const res = await api(role, method, url, body);
  expect(res.status).toBe(status);
  expect(await state()).toBe(before);
  expect(JSON.stringify(res.body)).not.toContain('HIDDEN-100D');
}
beforeAll(async () => {
  await dbReady;
  db = new sqlite3.Database(process.env.DATABASE_PATH);
  sql = require('../lib/db')(db); access = require('../lib/access')(sql);
  for (const [key, role, fullName, clientId] of [['admin','admin','Boundary Admin',''], ['assistant','assistant','Boundary Assistant',''], ['a','advocate','Advocate A',''], ['b','advocate','Advocate B',''], ['client','client','Shared Portal','shared'], ['otherClient','client','Other Portal','only-b']]) {
    users[key] = { id: `USER-${key}`, role, fullName, clientId, tokenVersion: 1 };
    await insert('users', { ...users[key], email: `${key}@example.test`, password: 'synthetic-unused-hash', isActive: 1 });
    tokens[key] = signAccessToken(users[key]);
  }
  for (const id of ['shared','only-a','only-b','intake']) await insert('clients', { id, name: `Client ${id}`, phone: id === 'only-b' ? 'HIDDEN-100D-PHONE' : 'synthetic-phone', email: `${id}@example.test` });
  for (const [id, clientId, assignedTo] of [['A1','shared','Advocate A'], ['A2','only-a','Advocate A'], ['B1','shared','Advocate B'], ['B2','only-b','Advocate B']]) {
    await insert('matters', { id, clientId, assignedTo, title: `Matter ${id}`, reference: `100D-${id}`, stage: 'Intake', solDate: date(-1), totalBilled: id === 'B2' ? 2000000 : 0 });
    await insert('tasks', { id: `T-${id}`, matterId: id, title: `${id.startsWith('B') ? 'HIDDEN-100D' : 'Authorized'} task ${id}`, assignee: assignedTo, dueDate: date(-1) });
    await insert('appearances', { id: `AP-${id}`, matterId: id, title: `${id.startsWith('B') ? 'HIDDEN-100D' : 'Authorized'} hearing ${id}`, attorney: assignedTo, date: date(2), outcome: 'INTERNAL-100D-OUTCOME', attendanceNote: 'INTERNAL-100D-ATTENDANCE' });
    await insert('deadlines', { id: `DL-${id}`, matterId: id, clientId, title: `${id.startsWith('B') ? 'HIDDEN-100D' : 'Authorized'} deadline ${id}`, dueDate: date(-1), status: 'Open', createdBy: users.admin.id, createdAt: date(0) });
    await insert('documents', { id: `DOC-${id}`, matterId: id, name: `${id}.pdf`, type: 'PDF', source: 'firm', clientVisible: 0, content: Buffer.from('SYNTHETIC-100D-DOCUMENT-BYTES') });
    await insert('invoices', { id: `I-${id}`, matterId: id, clientId, number: id, dueDate: date(-1), status: 'Outstanding', amount: 100 });
  }
  for (const [id, matterId, clientId] of [['FIRM','',''], ['CLIENT','','shared'], ['PRIVATE','','only-b'], ['INTAKE','','intake'], ['DANGLING','missing','shared'], ['MISMATCH','A1','only-b']]) {
    await insert('deadlines', { id, matterId, clientId, title: id, dueDate: date(-1), status: 'Open', createdBy: users.admin.id, createdAt: date(0) });
  }
  await insert('tasks', { id: 'T-DELEGATED', matterId: 'B2', title: 'Delegated task', assignee: 'Advocate A', dueDate: date(-1) });
  await insert('appearances', { id: 'AP-DELEGATED', matterId: 'B2', title: 'Delegated hearing', attorney: 'Advocate A', date: date(2) });
  for (const appearanceId of ['AP-A1','AP-DELEGATED']) {
    const matterId = appearanceId === 'AP-A1' ? 'A1' : 'B2';
    await insert('appearance_prep_items', { id: `PREP-${appearanceId}`, appearanceId, matterId, title: 'Record preparation', category: 'general', status: 'open', createdBy: users.admin.id, createdAt: date(0) });
    await insert('appearance_documents', { id: `LINK-${appearanceId}`, appearanceId, matterId, documentId: `DOC-${matterId}`, createdBy: users.admin.id, createdAt: date(0) });
  }
  // Earlier inaccessible rows must not consume the upcoming view's limit.
  for (let i=0;i<25;i++) await insert('appearances', { id: `AP-HIDDEN-${i}`, matterId: 'B1', title: 'HIDDEN-100D early hearing', attorney: 'Advocate B', date: date(1) });
  const enabled = await api('admin','put','/firm-settings',{ moduleSettings: { advancedCompliance: true } });
  expect(enabled.status).toBe(200);
  await insert('legal_deadline_rules', { id: 'RULE', ruleType: 'procedural', jurisdiction: 'Kenya', title: 'Synthetic rule', triggerEvent: 'test', periodValue: 2, periodUnit: 'days', citation: 'Synthetic test fixture only', createdBy: users.admin.id, createdAt: date(0) });
  for (const [id,matterId,clientId,createdBy] of [['S-A','A1','shared',users.admin.id],['S-B','B1','shared',users.admin.id],['S-CLIENT','','shared',users.admin.id],['S-OWN','','',users.a.id],['S-OTHER','','',users.b.id]]) {
    const res = await api(createdBy === users.a.id ? 'a' : createdBy === users.b.id ? 'b' : 'admin','post','/legal-deadline-suggestions',{ ruleId:'RULE',matterId,clientId,triggerDate:date(0),title:id });
    expect(res.status).toBe(201);
    await sql.run('UPDATE legal_deadline_suggestions SET id=? WHERE id=?',[id,res.body.id]);
  }
});
afterAll(async () => { if(db) await new Promise(resolve => db.close(resolve)); });

test.each([null,'client','otherClient'])('%s cannot enter staff workflow routes or cause write/audit side effects', async role => {
  const status = role ? 403 : 401;
  for(const url of ['/deadlines','/compliance-guidance','/tasks','/appearances','/appearances/upcoming','/appearances/AP-A1','/appearances/AP-A1/prep-items','/appearances/AP-A1/documents','/legal-deadline-suggestions']) expect((await api(role,'get',url)).status).toBe(status);
  for(const [method,url,body] of [['post','/deadlines',{title:'rejected',dueDate:date(1)}],['patch','/deadlines/DL-A1',{title:'rejected'}],['delete','/deadlines/DL-A1',{}],['post','/tasks',{matterId:'A1',title:'rejected'}],['patch','/tasks/T-A1',{completed:true}],['delete','/tasks/T-A1',{}],['post','/appearances',{matterId:'A1',title:'rejected',date:date(1)}],['patch','/appearances/AP-A1',{title:'rejected'}],['delete','/appearances/AP-A1',{}],['post','/whatsapp/reminders',{}]]) await denied(role,method,url,body,status);
});
test('manual and unified deadline sources scope before filters and compliance aggregation', async () => {
  const visible = await ids('a','/deadlines');
  for(const id of ['custom:DL-A1','custom:DL-A2','custom:FIRM','custom:CLIENT','task:T-DELEGATED','appearance:AP-DELEGATED','sol:A1','invoice:I-A1']) expect(visible).toContain(id);
  for(const id of ['custom:DL-B1','custom:DL-B2','custom:PRIVATE','custom:INTAKE','custom:DANGLING','custom:MISMATCH','task:T-B1','appearance:AP-B1','sol:B1','invoice:I-B1']) expect(visible).not.toContain(id);
  expect(JSON.stringify(await read('a','/deadlines?type=Court%20Date'))).not.toContain('HIDDEN-100D');
  expect(await ids('b','/deadlines')).toContain('custom:DL-B1');
  expect(await ids('b','/deadlines')).not.toContain('custom:DL-A1');
  const overdue = (await read('a','/deadlines')).filter(d=>d.status!=='Done' && d.dueDate<date(0)).length;
  const guidance = await read('a','/compliance-guidance');
  expect(guidance[0].summary).toBe(`${overdue} overdue deadline(s) require immediate review.`);
  expect(guidance[2].summary).toMatch(/^No high-value/);
  expect((await read('admin','/compliance-guidance'))[2].summary).toMatch(/^1 high-value/);
});
test('billing masking still applies to unified deadlines and guidance', async () => {
  await sql.run('UPDATE firm_settings SET advocateBillingVisibility=0');
  try { expect((await read('a','/deadlines')).some(r=>r.source==='invoice')).toBe(false); }
  finally { await sql.run('UPDATE firm_settings SET advocateBillingVisibility=1'); }
});
test.each(['admin','assistant'])('%s retains firm-wide reads including delegated records and previews', async role => {
  for(const url of ['/deadlines','/tasks','/appearances','/appearances/upcoming','/compliance-guidance']) expect((await read(role,url)).length).toBeGreaterThan(0);
  expect(await ids(role,'/deadlines')).toContain('custom:DL-B2');
  expect(await ids(role,'/tasks')).toContain('T-B2');
  expect(await ids(role,'/appearances')).toContain('AP-B2');
  expect((await read(role,'/appearances/AP-DELEGATED/prep-items')).length).toBe(1);
  expect((await read(role,'/appearances/AP-DELEGATED/documents')).length).toBe(1);
  const preview = await api(role,'post','/whatsapp/reminders',{days:3});
  expect(preview.status).toBe(200); expect(preview.body.reminders.some(r=>r.matterId==='B2')).toBe(true);
});
test.each(['admin','a'])('%s can CRUD an authorized manual deadline and shared unlinked deadline', async role => {
  for(const association of [{matterId:'A1'},{}, {clientId:'shared'}, {matterId:null,clientId:null}, {matterId:null,clientId:'shared'}, {matterId:'A1',clientId:null}]) {
    const made = await api(role,'post','/deadlines',{...association,title:'Allowed deadline',dueDate:date(1)});
    expect(made.status).toBe(200);
    if(association.matterId) expect(made.body.clientId).toBe('shared');
    const unlinked = await api(role,'patch','/deadlines/' + made.body.id,{matterId:null,clientId:null});
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.matterId).toBeNull();
    expect(unlinked.body.clientId).toBeNull();
    expect((await api(role,'patch',`/deadlines/${made.body.id}`,{status:'Done'})).body.status).toBe('Done');
    expect((await api(role,'delete',`/deadlines/${made.body.id}`,{})).status).toBe(200);
  }
});
test.each(['B1','B2'])('advocate cannot create deadline on inaccessible %s, even for shared client', async matterId => {
  await denied('a','post','/deadlines',{matterId,title:'Rejected',dueDate:date(1),owner:'Advocate A'});
});
test.each(['DL-B1','DL-B2','PRIVATE','DANGLING','MISMATCH'])('advocate cannot modify, detach or delete inaccessible deadline %s', async id => {
  await denied('a','patch',`/deadlines/${id}`,{matterId:'',clientId:'',title:'Rejected'});
  await denied('a','patch',`/deadlines/${id}`,{matterId:'A1',clientId:'shared'});
  await denied('a','delete',`/deadlines/${id}`,{});
});
test.each([{matterId:'B1',clientId:'shared'},{matterId:'',clientId:'only-b'},{matterId:'B2',clientId:'only-b'}])('deadline destination %j cannot bypass authorization', async body => {
  await denied('a','patch','/deadlines/DL-A1',body);
  await denied('a','patch','/deadlines/FIRM',body);
});
test('deadline associations validate client consistency, persisted IDs and input types before writing', async () => {
  for(const [body,status] of [[{matterId:'A1',clientId:'only-b'},400],[{matterId:'missing'},404],[{clientId:'missing'},404],[{matterId:42},400],[{clientId:[]},400]]) {
    await denied('admin','post','/deadlines',{...body,title:'Rejected',dueDate:date(1)},status);
    await denied('admin','patch','/deadlines/FIRM',body,status);
  }
  await denied('a','post','/deadlines',{clientId:'intake',title:'Rejected',dueDate:date(1)});
  const moved=await api('a','patch','/deadlines/DL-A2',{matterId:'A1',clientId:'shared'}); expect(moved.status).toBe(200);
  await sql.run("UPDATE deadlines SET matterId='A2',clientId='only-a' WHERE id='DL-A2'");
});
test('assistant can create tasks but cannot edit/delete tasks or write deadlines/appearances/preparation', async () => {
  const created = await api('assistant','post','/tasks',{matterId:'B2',title:'Assistant support'}); expect(created.status).toBe(200);
  for(const [method,url,body] of [['patch',`/tasks/${created.body.id}`,{title:'rejected'}],['delete',`/tasks/${created.body.id}`,{}],['post','/deadlines',{title:'rejected',dueDate:date(1)}],['patch','/deadlines/FIRM',{status:'Done'}],['delete','/deadlines/FIRM',{}],['post','/appearances',{matterId:'B1',title:'rejected',date:date(1)}],['patch','/appearances/AP-B1',{title:'rejected'}],['delete','/appearances/AP-B1',{}],['post','/appearances/AP-A1/prep-items',{title:'rejected'}],['post','/appearances/AP-A1/documents',{documentId:'DOC-A1'}]]) await denied('assistant',method,url,body);
});
test.each(['tasks','appearances'])('%s creation requires actual matter access; self-delegation is insufficient', async resource => {
  for(const [matterId,status] of [['B1',403],['B2',403],['missing',404],['',400],[null,400]]) await denied('a','post',`/${resource}`,{matterId,title:'Rejected',date:date(1),assignee:'Advocate A',attorney:'Advocate A'},status);
  for(const [role,matterId] of [['a','A1'],['admin','B2']]) {
    const made=await api(role,'post',`/${resource}`,{matterId,title:'Authorized create',date:date(1)}); expect(made.status).toBe(200);
    expect((await api(role,'patch',`/${resource}/${made.body.id}`,{title:'Authorized edit'})).status).toBe(200);
    expect((await api(role,'delete',`/${resource}/${made.body.id}`,{})).status).toBe(200);
  }
});
test('task list scope and direct delegated update/delete remain intact without matter reassociation', async () => {
  expect(await ids('a','/tasks')).toEqual(['T-A1','T-A2','T-DELEGATED']);
  expect(await ids('a','/tasks?matterId=B1')).toEqual([]);
  expect(await ids('a','/tasks?matterId=B2')).toEqual(['T-DELEGATED']);
  const updated=await api('a','patch','/tasks/T-DELEGATED',{completed:true,matterId:'A1'});
  expect(updated.status).toBe(200); expect(updated.body).toMatchObject({completed:1,matterId:'B2'});
  for(const method of ['patch','delete']) await denied('a',method,'/tasks/T-B1',{completed:true});
  await insert('tasks',{id:'T-DELETE-DELEGATE',matterId:'B2',title:'Delegated deletion',assignee:'Advocate A'});
  expect((await api('a','delete','/tasks/T-DELETE-DELEGATE',{})).status).toBe(200);
});
test('appearance lists and upcoming filters preserve delegation before limits', async () => {
  const expected=['AP-A1','AP-A2','AP-DELEGATED'];
  expect(await ids('a','/appearances')).toEqual(expected);
  expect(await ids('a','/appearances/upcoming')).toEqual(expected);
  expect(await ids('a','/appearances/upcoming?matterId=B1')).toEqual([]);
  expect(await ids('a','/appearances?matterId=B2')).toEqual(['AP-DELEGATED']);
  expect((await read('a','/appearances/AP-DELEGATED')).id).toBe('AP-DELEGATED');
  expect((await api('a','patch','/appearances/AP-DELEGATED',{title:'Delegated edited',matterId:'B2'})).status).toBe(200);
  for(const method of ['patch','delete']) await denied('a',method,'/appearances/AP-B1',{title:'Rejected'});
});
test('delegation never grants parent matter/client, other child records, document metadata or bytes', async () => {
  expect(await access.canAccessTask({user:users.a},'T-DELEGATED')).toBe(true);
  expect(await access.canAccessAppearance({user:users.a},'AP-DELEGATED')).toBe(true);
  expect(await access.canAccessMatter({user:users.a},'B2')).toBe(false);
  expect(await access.canAccessClient({user:users.a},'only-b')).toBe(false);
  for(const url of ['/matters/B2','/clients/only-b/snapshot','/appearances/AP-B2','/documents/DOC-B2/download']) expect((await api('a','get',url)).status).toBe(403);
  expect(await read('a','/appearances/AP-DELEGATED/documents')).toEqual([]);
  await denied('a','post','/appearances/AP-DELEGATED/documents',{documentId:'DOC-B2'});
  expect((await read('a','/appearances/AP-DELEGATED/prep-items')).length).toBe(1);
  expect((await api('a','patch','/appearance-prep-items/PREP-AP-DELEGATED',{status:'done'})).status).toBe(200);
});
test.each([['AP-A1','B1',403],['AP-B1','A1',403],['AP-DELEGATED','A2',403],['AP-A2','missing',404],['AP-A2','',400],['AP-A2',null,400]])('appearance %s cannot move to %s without both matter authorities', async (id,matterId,status) => {
  await denied('a','patch',`/appearances/${id}`,{matterId,title:'Rejected'},status);
});
test.each(['admin','a'])('%s cannot reparent appearance with linked prep/documents even between accessible matters', async role => {
  await denied(role,'patch','/appearances/AP-A1',{matterId:'A2'},409);
  expect((await read(role,'/appearances/AP-A1/documents'))[0].matterId).toBe('A1');
  expect((await read(role,'/appearances/AP-A1/prep-items'))[0].matterId).toBe('A1');
});
test('link-free authorized appearance reparenting and delegated deletion remain available', async () => {
  const made=await api('admin','post','/appearances',{matterId:'A1',title:'Movable',date:date(1)}); expect(made.status).toBe(200);
  expect((await api('a','patch',`/appearances/${made.body.id}`,{matterId:'A2'})).body.matterId).toBe('A2');
  expect((await api('admin','patch',`/appearances/${made.body.id}`,{matterId:'B2',attorney:'Advocate A'})).body.matterId).toBe('B2');
  expect((await api('a','delete',`/appearances/${made.body.id}`,{})).status).toBe(200);
});
test('mixed-client legal suggestions always intersect row scope and retain owner-only unlinked policy', async () => {
  expect(await ids('a','/legal-deadline-suggestions?clientId=shared')).toEqual(['S-A','S-CLIENT']);
  expect(await ids('b','/legal-deadline-suggestions?clientId=shared')).toEqual(['S-B','S-CLIENT']);
  expect(await ids('a','/legal-deadline-suggestions?clientId=shared&status=draft&ruleId=RULE')).toEqual(['S-A','S-CLIENT']);
  expect(await ids('a','/legal-deadline-suggestions')).toEqual(['S-A','S-CLIENT','S-OWN']);
  expect((await api('a','get','/legal-deadline-suggestions?matterId=B1&clientId=shared')).status).toBe(403);
  expect(await ids('assistant','/legal-deadline-suggestions')).toHaveLength(5);
});
test('court contact preview requires matter scope, even for delegated appearances, and does not send reminders', async () => {
  const before=await state(); const res=await api('a','post','/whatsapp/reminders',{days:3});
  expect(res.status).toBe(200); expect(res.body.count).toBe(2);
  expect(res.body.reminders.map(r=>r.matterId).sort()).toEqual(['A1','A2']);
  expect(JSON.stringify(res.body)).not.toMatch(/HIDDEN-100D|B2/);
  expect(await state()).toBe(before);
});
test.each([['client',['A1','B1']],['otherClient',['B2']]])('%s portal remains own-client isolated with staff fields stripped', async (role,matterIds) => {
  const dashboard=await read(role,'/client/dashboard');
  expect(dashboard.matters.map(m=>m.id).sort()).toEqual(matterIds);
  expect(dashboard.appearances.every(a=>matterIds.includes(a.matterId))).toBe(true);
  for(const field of ['outcome','attendanceStatus','appearedBy','clientAttended','attendanceNote','attendanceUpdatedBy','attendanceUpdatedAt','prepItems']) expect(dashboard.appearances.every(a=>a[field]===undefined)).toBe(true);
  expect(dashboard.documents).toEqual([]);
  expect(JSON.stringify(dashboard)).not.toContain('INTERNAL-100D');
});
