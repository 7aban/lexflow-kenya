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

function parseSafeMetadata(event) {
  expect(event).toBeDefined();
  expect(event.actor_role).toBeTruthy();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

async function getGlobalSideEffectCounts() {
  const [documents, tasks, deadlines, notifications, reminderLogs] = await Promise.all([
    dbAll('SELECT COUNT(*) AS count FROM documents'),
    dbAll('SELECT COUNT(*) AS count FROM tasks'),
    dbAll('SELECT COUNT(*) AS count FROM deadlines'),
    dbAll('SELECT COUNT(*) AS count FROM notifications'),
    dbAll('SELECT COUNT(*) AS count FROM reminder_logs'),
  ]);
  return {
    documents: documents[0].count,
    tasks: tasks[0].count,
    deadlines: deadlines[0].count,
    notifications: notifications[0].count,
    reminderLogs: reminderLogs[0].count,
  };
}

describe('R18-2 document template library skeleton', () => {
  const runId = Date.now();
  const password = 'Str0ng!Passw0rd2026!';
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let activeTemplateId;
  let inactiveTemplateId;
  let preCounts;

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

    const assistantRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    expect(assistantRes.statusCode).toBe(200);
    assistantToken = assistantRes.body.token;

    const clientEmail = `r18-doctemplate-client-${runId}@example.com`;
    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R18 Doc Template Client ${runId}`, email: clientEmail });
    expect(clientRes.statusCode).toBe(200);
    const clientId = clientRes.body.id;

    const clientUserRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: clientEmail, password, fullName: `R18 Doc Template Client User ${runId}`, role: 'client', clientId });
    expect(clientUserRes.statusCode).toBe(200);

    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientEmail, password });
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;

    preCounts = await getGlobalSideEffectCounts();
  });

  test('1. admin can create a document template', async () => {
    const res = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R18 Doc Template ${runId}`,
        description: 'Reusable engagement letter template.',
        practiceArea: 'Commercial Law',
        category: 'Engagement',
        bodyMarkup: 'Dear {{client.name}},\n\nWelcome to {{firm.name}}.',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe(`R18 Doc Template ${runId}`);
    expect(res.body.description).toBe('Reusable engagement letter template.');
    expect(res.body.practiceArea).toBe('Commercial Law');
    expect(res.body.category).toBe('Engagement');
    expect(res.body.bodyMarkup).toBe('Dear {{client.name}},\n\nWelcome to {{firm.name}}.');
    expect(Number(res.body.active)).toBe(1);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id).toMatch(/^DTPL/);
    expect(typeof res.body.createdAt).toBe('string');
    expect(res.body.createdAt).toBe(res.body.updatedAt);
    activeTemplateId = res.body.id;
  });

  test('2. created template is returned by staff list (admin, advocate, assistant)', async () => {
    const adminList = await request(app)
      .get('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.statusCode).toBe(200);
    expect(adminList.body.some(t => t.id === activeTemplateId)).toBe(true);

    const advocateList = await request(app)
      .get('/api/document-templates')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(advocateList.statusCode).toBe(200);
    expect(advocateList.body.some(t => t.id === activeTemplateId)).toBe(true);

    const assistantList = await request(app)
      .get('/api/document-templates')
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(assistantList.statusCode).toBe(200);
    expect(assistantList.body.some(t => t.id === activeTemplateId)).toBe(true);

    const detailRes = await request(app)
      .get(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.body.id).toBe(activeTemplateId);
    expect(Number(detailRes.body.active)).toBe(1);
  });

  test('3. admin can update name, description, practiceArea, category, bodyMarkup', async () => {
    const res = await request(app)
      .patch(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R18 Doc Template Updated ${runId}`,
        description: 'Updated engagement letter template.',
        practiceArea: 'Dispute Resolution',
        category: 'Letterhead',
        bodyMarkup: 'Updated body for {{matter.title}}.',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe(`R18 Doc Template Updated ${runId}`);
    expect(res.body.description).toBe('Updated engagement letter template.');
    expect(res.body.practiceArea).toBe('Dispute Resolution');
    expect(res.body.category).toBe('Letterhead');
    expect(res.body.bodyMarkup).toBe('Updated body for {{matter.title}}.');
    expect(Number(res.body.active)).toBe(1);
    expect(typeof res.body.updatedAt).toBe('string');
    expect(res.body.updatedAt).not.toBe(res.body.createdAt);
  });

  test('4. admin can deactivate template; list excludes inactive by default, includes when includeInactive=1', async () => {
    const createRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R18 Inactive Doc Template ${runId}`,
        description: 'Will be soft-deleted.',
      });
    expect(createRes.statusCode).toBe(200);
    inactiveTemplateId = createRes.body.id;

    const deleteRes = await request(app)
      .delete(`/api/document-templates/${inactiveTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.id).toBe(inactiveTemplateId);
    expect(deleteRes.body.deleted).toBe(true);
    expect(Number(deleteRes.body.active)).toBe(0);

    const listRes = await request(app)
      .get('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.some(t => t.id === inactiveTemplateId)).toBe(false);

    const includeRes = await request(app)
      .get('/api/document-templates?includeInactive=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(includeRes.statusCode).toBe(200);
    expect(includeRes.body.some(t => t.id === inactiveTemplateId)).toBe(true);

    const detailRes = await request(app)
      .get(`/api/document-templates/${inactiveTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailRes.statusCode).toBe(404);
  });

  test('5. empty template name is rejected on create and update', async () => {
    const createEmpty = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '   ' });
    expect(createEmpty.statusCode).toBe(400);
    expect(createEmpty.body.error).toMatch(/name/i);

    const createMissing = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(createMissing.statusCode).toBe(400);

    const updateEmpty = await request(app)
      .patch(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '   ' });
    expect(updateEmpty.statusCode).toBe(400);
    expect(updateEmpty.body.error).toMatch(/name/i);
  });

  test('6. advocate can list and read but cannot create, update, or delete templates', async () => {
    const listRes = await request(app)
      .get('/api/document-templates')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.some(t => t.id === activeTemplateId)).toBe(true);

    const detailRes = await request(app)
      .get(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(detailRes.statusCode).toBe(200);

    const createRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ name: `R18 Advocate Doc Template ${runId}` });
    expect(createRes.statusCode).toBe(403);

    const updateRes = await request(app)
      .patch(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ name: 'Advocate Update Denied' });
    expect(updateRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('7. assistant can list and read but cannot create, update, or delete templates', async () => {
    const listRes = await request(app)
      .get('/api/document-templates')
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.some(t => t.id === activeTemplateId)).toBe(true);

    const detailRes = await request(app)
      .get(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(detailRes.statusCode).toBe(200);

    const createRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ name: `R18 Assistant Doc Template ${runId}` });
    expect(createRes.statusCode).toBe(403);

    const updateRes = await request(app)
      .patch(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ name: 'Assistant Update Denied' });
    expect(updateRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('8. client cannot list, read, create, update, or delete document templates', async () => {
    const listRes = await request(app)
      .get('/api/document-templates')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(listRes.statusCode).toBe(403);

    const detailRes = await request(app)
      .get(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(detailRes.statusCode).toBe(403);

    const createRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: `R18 Client Doc Template ${runId}` });
    expect(createRes.statusCode).toBe(403);

    const updateRes = await request(app)
      .patch(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'Client Update Denied' });
    expect(updateRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/document-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('9. audit events are recorded with safe metadata for create, update, and delete', async () => {
    const created = await latestAudit('document_template_created', activeTemplateId);
    const createdMetadata = parseSafeMetadata(created);
    expect(createdMetadata.templateId).toBe(activeTemplateId);
    expect(createdMetadata.active).toBe(1);
    expect(typeof createdMetadata.name).toBe('string');
    expect(createdMetadata.name).toBeTruthy();

    const updated = await latestAudit('document_template_updated', activeTemplateId);
    const updatedMetadata = parseSafeMetadata(updated);
    expect(updatedMetadata.templateId).toBe(activeTemplateId);
    expect(updatedMetadata.updatedFields).toContain('name');
    expect(updatedMetadata.updatedFields).toContain('bodyMarkup');
    expect(updatedMetadata.active).toBe(1);

    const deleted = await latestAudit('document_template_deleted', inactiveTemplateId);
    const deletedMetadata = parseSafeMetadata(deleted);
    expect(deletedMetadata.templateId).toBe(inactiveTemplateId);
    expect(deletedMetadata.active).toBe(0);
  });

  test('10. existing uploaded document list/download behavior is not touched', async () => {
    // Confirm canonical document endpoints still work for staff; no regression.
    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(mattersRes.statusCode).toBe(200);
    const sampleMatter = mattersRes.body[0];
    expect(sampleMatter).toBeDefined();

    const docsRes = await request(app)
      .get(`/api/matters/${sampleMatter.id}/documents`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(Array.isArray(docsRes.body)).toBe(true);
  });

  test('11. document template lifecycle creates no rows in documents, tasks, deadlines, notifications, reminder_logs', async () => {
    const postCounts = await getGlobalSideEffectCounts();
    expect(postCounts.documents).toBe(preCounts.documents);
    expect(postCounts.tasks).toBe(preCounts.tasks);
    expect(postCounts.deadlines).toBe(preCounts.deadlines);
    expect(postCounts.notifications).toBe(preCounts.notifications);
    expect(postCounts.reminderLogs).toBe(preCounts.reminderLogs);
  });
});
