const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
    });
  });
}

async function latestAudit(action, entityId) {
  const rows = await dbAll(
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
    [action, entityId || ''],
  );
  return rows[0];
}

async function getChecklistSideEffectCounts(matterId) {
  const [tasks, deadlines, notifications, reminderLogs] = await Promise.all([
    dbAll('SELECT COUNT(*) AS count FROM tasks WHERE matterId=?', [matterId]),
    dbAll('SELECT COUNT(*) AS count FROM deadlines WHERE matterId=?', [matterId]),
    dbAll('SELECT COUNT(*) AS count FROM notifications WHERE matterId=?', [matterId]),
    dbAll('SELECT COUNT(*) AS count FROM reminder_logs WHERE matterId=?', [matterId]),
  ]);
  return {
    tasks: tasks[0].count,
    deadlines: deadlines[0].count,
    notifications: notifications[0].count,
    reminderLogs: reminderLogs[0].count,
  };
}

async function expectNoChecklistSideEffects(matterId) {
  await expect(getChecklistSideEffectCounts(matterId)).resolves.toEqual({
    tasks: 0,
    deadlines: 0,
    notifications: 0,
    reminderLogs: 0,
  });
}

function parseSafeMetadata(event) {
  expect(event).toBeDefined();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

function expectIsoTimestamp(value) {
  expect(typeof value).toBe('string');
  expect(value).toBeTruthy();
  expect(Number.isNaN(Date.parse(value))).toBe(false);
}

function waitForNextTimestamp() {
  return new Promise(resolve => setTimeout(resolve, 10));
}

describe('R17-2 matter checklist items', () => {
  const runId = Date.now();
  const password = 'Str0ng!Passw0rd2026!';
  let adminToken;
  let advocateToken;
  let otherAdvocateToken;
  let assistantToken;
  let clientToken;
  let advocateName;
  let otherAdvocateName;
  let clientId;
  let matterId;
  let otherMatterId;
  let adminItemId;
  let assistantItemId;

  beforeAll(async () => {
    await dbReady;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;

    const advocateRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(advocateRes.statusCode).toBe(200);
    advocateToken = advocateRes.body.token;
    advocateName = advocateRes.body.user.fullName;

    const assistantRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    expect(assistantRes.statusCode).toBe(200);
    assistantToken = assistantRes.body.token;

    otherAdvocateName = `R17 Other Advocate ${runId}`;
    const otherAdvocateEmail = `r17-other-advocate-${runId}@example.com`;
    const otherAdvocateRegister = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: otherAdvocateEmail, password, fullName: otherAdvocateName, role: 'advocate' });
    expect(otherAdvocateRegister.statusCode).toBe(200);

    const otherAdvocateLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: otherAdvocateEmail, password });
    expect(otherAdvocateLogin.statusCode).toBe(200);
    otherAdvocateToken = otherAdvocateLogin.body.token;

    const clientEmail = `r17-client-${runId}@example.com`;
    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R17 Client ${runId}`, email: clientEmail });
    expect(clientRes.statusCode).toBe(200);
    clientId = clientRes.body.id;

    const clientUserRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: clientEmail, password, fullName: `R17 Client User ${runId}`, role: 'client', clientId });
    expect(clientUserRes.statusCode).toBe(200);

    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientEmail, password });
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;

    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `R17 Checklist Matter ${runId}`, assignedTo: advocateName, practiceArea: 'Commercial Law' });
    expect(matterRes.statusCode).toBe(200);
    matterId = matterRes.body.id;

    const otherMatterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `R17 Other Advocate Matter ${runId}`, assignedTo: otherAdvocateName, practiceArea: 'Employment' });
    expect(otherMatterRes.statusCode).toBe(200);
    otherMatterId = otherMatterRes.body.id;

    const assistantItemRes = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 Assistant Toggle Item ${runId}`, position: 3 });
    expect(assistantItemRes.statusCode).toBe(200);
    assistantItemId = assistantItemRes.body.id;
  });

  async function createInvariantMatter(title) {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title, assignedTo: advocateName, practiceArea: 'Commercial Law' });
    expect(matterRes.statusCode).toBe(200);
    return matterRes.body.id;
  }

  test('admin can create checklist item and structured audit event is safe', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 Safe Checklist ${runId}`, notes: 'Admin-created checklist item.', position: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.body.title).toBe(`R17 Safe Checklist ${runId}`);
    expect(res.body.completed).toBe(0);
    adminItemId = res.body.id;

    const event = await latestAudit('matter_checklist_item_created', adminItemId);
    expect(event.action).toBe('matter_checklist_item_created');
    expect(event.entity_type).toBe('matter_checklist_item');
    expect(event.matter_id).toBe(matterId);
    const metadata = parseSafeMetadata(event);
    expect(metadata.matterId).toBe(matterId);
    expect(metadata.title).toBe(`R17 Safe Checklist ${runId}`);
  });

  test('admin can create and assigned advocate can patch checklist due date and assignee metadata', async () => {
    const metadataMatterId = await createInvariantMatter(`R17 Metadata Matter ${runId}`);
    const dueDate = '2026-06-15';
    const assignee = advocateName;

    const createRes = await request(app)
      .post(`/api/matters/${metadataMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: `R17 Metadata Item ${runId}`,
        notes: 'Metadata create.',
        position: 1,
        dueDate,
        assignee,
      });
    expect(createRes.statusCode).toBe(200);
    expect(createRes.body.dueDate).toBe(dueDate);
    expect(createRes.body.assignee).toBe(assignee);
    expect(createRes.body.updatedAt).toBe(createRes.body.createdAt);
    expectIsoTimestamp(createRes.body.updatedAt);
    const createdUpdatedAt = createRes.body.updatedAt;

    const listRes = await request(app)
      .get(`/api/matters/${metadataMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.body.find(item => item.id === createRes.body.id);
    expect(listed).toBeDefined();
    expect(listed.dueDate).toBe(dueDate);
    expect(listed.assignee).toBe(assignee);
    expect(listed.updatedAt).toBe(createdUpdatedAt);

    await waitForNextTimestamp();
    const nextDueDate = '2026-07-01';
    const nextAssignee = `R17 Checklist Owner ${runId}`;
    const updateRes = await request(app)
      .patch(`/api/matters/${metadataMatterId}/checklist-items/${createRes.body.id}`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ dueDate: nextDueDate, assignee: nextAssignee });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.body.dueDate).toBe(nextDueDate);
    expect(updateRes.body.assignee).toBe(nextAssignee);
    expectIsoTimestamp(updateRes.body.updatedAt);
    expect(new Date(updateRes.body.updatedAt).getTime()).toBeGreaterThan(new Date(createdUpdatedAt).getTime());
  });

  test('manual checklist item create does not create task, deadline, notification, or reminder rows', async () => {
    const invariantMatterId = await createInvariantMatter(`R17 No Side Effect Create Matter ${runId}`);

    await expectNoChecklistSideEffects(invariantMatterId);

    const res = await request(app)
      .post(`/api/matters/${invariantMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: `R17 No Side Effect Create Item ${runId}`,
        notes: 'Create invariant.',
        position: 1,
        dueDate: '2026-06-20',
        assignee: advocateName,
      });
    expect(res.statusCode).toBe(200);

    await expectNoChecklistSideEffects(invariantMatterId);
  });

  test('manual checklist item content update does not create task, deadline, notification, or reminder rows', async () => {
    const invariantMatterId = await createInvariantMatter(`R17 No Side Effect Update Matter ${runId}`);

    const createRes = await request(app)
      .post(`/api/matters/${invariantMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 No Side Effect Update Item ${runId}`, notes: 'Before update.', position: 2 });
    expect(createRes.statusCode).toBe(200);
    await expectNoChecklistSideEffects(invariantMatterId);

    const updateRes = await request(app)
      .patch(`/api/matters/${invariantMatterId}/checklist-items/${createRes.body.id}`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({
        title: `R17 No Side Effect Updated Item ${runId}`,
        notes: 'After update.',
        position: 3,
        dueDate: '2026-07-05',
        assignee: `R17 Updated Owner ${runId}`,
      });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.body.title).toBe(`R17 No Side Effect Updated Item ${runId}`);
    expect(updateRes.body.position).toBe(3);
    expect(updateRes.body.dueDate).toBe('2026-07-05');
    expect(updateRes.body.assignee).toBe(`R17 Updated Owner ${runId}`);

    await expectNoChecklistSideEffects(invariantMatterId);
  });

  test('manual checklist item toggles do not create task, deadline, notification, or reminder rows', async () => {
    const invariantMatterId = await createInvariantMatter(`R17 No Side Effect Toggle Matter ${runId}`);

    const createRes = await request(app)
      .post(`/api/matters/${invariantMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 No Side Effect Toggle Item ${runId}`, position: 4 });
    expect(createRes.statusCode).toBe(200);
    const createdUpdatedAt = createRes.body.updatedAt;
    expectIsoTimestamp(createdUpdatedAt);
    await expectNoChecklistSideEffects(invariantMatterId);

    await waitForNextTimestamp();
    const completeRes = await request(app)
      .patch(`/api/matters/${invariantMatterId}/checklist-items/${createRes.body.id}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ completed: true });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.body.completed).toBe(1);
    expectIsoTimestamp(completeRes.body.updatedAt);
    expect(new Date(completeRes.body.updatedAt).getTime()).toBeGreaterThan(new Date(createdUpdatedAt).getTime());
    await expectNoChecklistSideEffects(invariantMatterId);

    await waitForNextTimestamp();
    const reopenRes = await request(app)
      .patch(`/api/matters/${invariantMatterId}/checklist-items/${createRes.body.id}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ completed: false });
    expect(reopenRes.statusCode).toBe(200);
    expect(reopenRes.body.completed).toBe(0);
    expectIsoTimestamp(reopenRes.body.updatedAt);
    expect(new Date(reopenRes.body.updatedAt).getTime()).toBeGreaterThan(new Date(completeRes.body.updatedAt).getTime());
    await expectNoChecklistSideEffects(invariantMatterId);
  });

  test('admin can list checklist items', async () => {
    const res = await request(app)
      .get(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(item => item.id === adminItemId)).toBe(true);
  });

  test('advocate assigned to matter can create, toggle, edit, and delete', async () => {
    const createRes = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ title: `R17 Advocate Item ${runId}`, position: 4 });
    expect(createRes.statusCode).toBe(200);
    const itemId = createRes.body.id;

    const completeRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${itemId}`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ completed: true });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.body.completed).toBe(1);

    const editRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${itemId}`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ title: `R17 Advocate Item Renamed ${runId}`, notes: 'Updated by assigned advocate.', position: 2 });
    expect(editRes.statusCode).toBe(200);
    expect(editRes.body.title).toBe(`R17 Advocate Item Renamed ${runId}`);
    expect(editRes.body.position).toBe(2);

    const deleteRes = await request(app)
      .delete(`/api/matters/${matterId}/checklist-items/${itemId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.deleted).toBe(true);
  });

  test('advocate not assigned to matter gets 403', async () => {
    const res = await request(app)
      .get(`/api/matters/${otherMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(403);

    const rows = await dbAll(
      "SELECT * FROM audit_events WHERE action='forbidden_matter_checklist_item_access' AND entity_id=? ORDER BY timestamp DESC LIMIT 1",
      [otherMatterId],
    );
    expect(rows.length).toBe(1);
    parseSafeMetadata(rows[0]);
  });

  test('assistant can list checklist items', async () => {
    const res = await request(app)
      .get(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.some(item => item.id === assistantItemId)).toBe(true);
  });

  test('assistant can toggle completed', async () => {
    const res = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ completed: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.completed).toBe(1);
    expect(res.body.completedAt).toBeTruthy();
  });

  test('assistant cannot create checklist items', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ title: `R17 Assistant Create ${runId}` });
    expect(res.statusCode).toBe(403);
  });

  test('assistant cannot rename, reorder, edit metadata, or delete checklist items', async () => {
    const renameRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ title: `R17 Assistant Rename ${runId}` });
    expect(renameRes.statusCode).toBe(403);

    const reorderRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ position: 9 });
    expect(reorderRes.statusCode).toBe(403);

    const dueDateRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ dueDate: '2026-08-01' });
    expect(dueDateRes.statusCode).toBe(403);

    const assigneeRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ assignee: `R17 Assistant Forbidden Owner ${runId}` });
    expect(assigneeRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('client gets 403 on checklist endpoints', async () => {
    const listRes = await request(app)
      .get(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(listRes.statusCode).toBe(403);

    const createRes = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ title: `R17 Client Item ${runId}` });
    expect(createRes.statusCode).toBe(403);

    const updateRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ completed: false });
    expect(updateRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/matters/${matterId}/checklist-items/${assistantItemId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('client matter detail does not expose checklist items', async () => {
    const res = await request(app)
      .get(`/api/matters/${matterId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(matterId);
    expect(res.body).not.toHaveProperty('checklistItems');
  });

  test('reorder position update persists in list order', async () => {
    const first = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 Order B ${runId}`, position: 20 });
    expect(first.statusCode).toBe(200);

    const second = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 Order A ${runId}`, position: 10 });
    expect(second.statusCode).toBe(200);

    const update = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${first.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ position: 5 });
    expect(update.statusCode).toBe(200);

    const list = await request(app)
      .get(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(200);
    const orderedTitles = list.body
      .filter(item => String(item.title || '').startsWith('R17 Order'))
      .map(item => item.title);
    expect(orderedTitles).toEqual([`R17 Order B ${runId}`, `R17 Order A ${runId}`]);
  });

  test('deleting matter cascades checklist items', async () => {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `R17 Cascade Matter ${runId}`, assignedTo: advocateName });
    expect(matterRes.statusCode).toBe(200);
    const cascadeMatterId = matterRes.body.id;

    const itemRes = await request(app)
      .post(`/api/matters/${cascadeMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 Cascade Item ${runId}` });
    expect(itemRes.statusCode).toBe(200);

    const deleteRes = await request(app)
      .delete(`/api/matters/${cascadeMatterId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteRes.statusCode).toBe(200);

    const rows = await dbAll('SELECT * FROM matter_checklist_items WHERE matterId=?', [cascadeMatterId]);
    expect(rows).toHaveLength(0);
  });

  test('empty title is rejected with 400', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '   ' });
    expect(res.statusCode).toBe(400);
  });

  test('completed and reopened audit events are recorded with safe metadata', async () => {
    const createRes = await request(app)
      .post(`/api/matters/${matterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 Audit Toggle ${runId}` });
    expect(createRes.statusCode).toBe(200);
    const itemId = createRes.body.id;

    const completeRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ completed: true });
    expect(completeRes.statusCode).toBe(200);

    const completedEvent = await latestAudit('matter_checklist_item_completed', itemId);
    expect(completedEvent.action).toBe('matter_checklist_item_completed');
    expect(completedEvent.matter_id).toBe(matterId);
    parseSafeMetadata(completedEvent);

    const reopenRes = await request(app)
      .patch(`/api/matters/${matterId}/checklist-items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ completed: false });
    expect(reopenRes.statusCode).toBe(200);

    const reopenedEvent = await latestAudit('matter_checklist_item_reopened', itemId);
    expect(reopenedEvent.action).toBe('matter_checklist_item_reopened');
    expect(reopenedEvent.matter_id).toBe(matterId);
    parseSafeMetadata(reopenedEvent);
  });

  test('other assigned advocate can manage their own matter checklist', async () => {
    const res = await request(app)
      .post(`/api/matters/${otherMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${otherAdvocateToken}`)
      .send({ title: `R17 Other Advocate Own Item ${runId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body.matterId).toBe(otherMatterId);
  });
});
