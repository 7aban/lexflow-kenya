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
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'password', 'secret', 'rawbody']) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R17-3 checklist templates', () => {
  const runId = Date.now();
  const password = 'Str0ng!Passw0rd2026!';
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let advocateName;
  let clientId;
  let matterId;
  let otherMatterId;
  let activeTemplateId;
  let inactiveTemplateId;

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

    const clientEmail = `r17-template-client-${runId}@example.com`;
    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R17 Template Client ${runId}`, email: clientEmail });
    expect(clientRes.statusCode).toBe(200);
    clientId = clientRes.body.id;

    const clientUserRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: clientEmail, password, fullName: `R17 Template Client User ${runId}`, role: 'client', clientId });
    expect(clientUserRes.statusCode).toBe(200);

    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientEmail, password });
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;

    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `R17 Template Matter ${runId}`, assignedTo: advocateName, practiceArea: 'Commercial Law' });
    expect(matterRes.statusCode).toBe(200);
    matterId = matterRes.body.id;

    const otherMatterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `R17 Template Other Matter ${runId}`, assignedTo: 'Michael Oduor', practiceArea: 'Litigation' });
    expect(otherMatterRes.statusCode).toBe(200);
    otherMatterId = otherMatterRes.body.id;
  });

  test('admin can create template with ordered items', async () => {
    const res = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R17 Template Library ${runId}`,
        description: 'Reusable checklist template.',
        practiceArea: 'Commercial Law',
        items: [
          { title: `R17 Second Template Item ${runId}`, notes: 'Second note', position: 1 },
          { title: `R17 First Template Item ${runId}`, notes: 'First note', position: 0 },
        ],
      });

    expect(res.statusCode).toBe(200);
    activeTemplateId = res.body.id;
    expect(res.body.name).toBe(`R17 Template Library ${runId}`);
    expect(res.body.active).toBe(1);
    expect(res.body.items.map(item => item.title)).toEqual([
      `R17 First Template Item ${runId}`,
      `R17 Second Template Item ${runId}`,
    ]);
  });

  test('admin can list template with ordered items', async () => {
    const res = await request(app)
      .get('/api/checklist-templates')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    const template = res.body.find(item => item.id === activeTemplateId);
    expect(template).toBeDefined();
    expect(template.items.map(item => item.position)).toEqual([0, 1]);
  });

  test('admin can update template metadata and items', async () => {
    const res = await request(app)
      .patch(`/api/checklist-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R17 Template Library Updated ${runId}`,
        description: 'Updated reusable checklist template.',
        practiceArea: 'Dispute Resolution',
        items: [
          { title: `R17 Apply First ${runId}`, notes: 'Apply first', position: 0 },
          { title: `R17 Apply Second ${runId}`, notes: 'Apply second', position: 1 },
        ],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe(`R17 Template Library Updated ${runId}`);
    expect(res.body.practiceArea).toBe('Dispute Resolution');
    expect(res.body.items.map(item => item.title)).toEqual([
      `R17 Apply First ${runId}`,
      `R17 Apply Second ${runId}`,
    ]);
  });

  test('admin can soft-delete template', async () => {
    const createRes = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R17 Inactive Template ${runId}`,
        items: [{ title: `R17 Inactive Item ${runId}`, position: 0 }],
      });
    expect(createRes.statusCode).toBe(200);
    inactiveTemplateId = createRes.body.id;

    const deleteRes = await request(app)
      .delete(`/api/checklist-templates/${inactiveTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.active).toBe(0);

    const listRes = await request(app)
      .get('/api/checklist-templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.some(template => template.id === inactiveTemplateId)).toBe(false);
  });

  test('advocate can list templates', async () => {
    const res = await request(app)
      .get('/api/checklist-templates')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.some(template => template.id === activeTemplateId)).toBe(true);
  });

  test('advocate cannot create, update, or delete templates', async () => {
    const createRes = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ name: `R17 Advocate Template ${runId}`, items: [{ title: 'Nope' }] });
    expect(createRes.statusCode).toBe(403);

    const updateRes = await request(app)
      .patch(`/api/checklist-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ name: 'Advocate Update Denied' });
    expect(updateRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/checklist-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('assistant cannot create, update, or delete templates', async () => {
    const createRes = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ name: `R17 Assistant Template ${runId}`, items: [{ title: 'Nope' }] });
    expect(createRes.statusCode).toBe(403);

    const updateRes = await request(app)
      .patch(`/api/checklist-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ name: 'Assistant Update Denied' });
    expect(updateRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/checklist-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('client cannot access template endpoints', async () => {
    const listRes = await request(app)
      .get('/api/checklist-templates')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(listRes.statusCode).toBe(403);

    const createRes = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: `R17 Client Template ${runId}`, items: [{ title: 'Nope' }] });
    expect(createRes.statusCode).toBe(403);

    const updateRes = await request(app)
      .patch(`/api/checklist-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'Client Update Denied' });
    expect(updateRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/checklist-templates/${activeTemplateId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  test('admin can apply active template to any matter', async () => {
    const res = await request(app)
      .post(`/api/matters/${otherMatterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ templateId: activeTemplateId });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every(item => item.matterId === otherMatterId)).toBe(true);
  });

  test('advocate can apply active template to assigned matter', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ templateId: activeTemplateId });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every(item => item.matterId === matterId)).toBe(true);
  });

  test('advocate cannot apply template to unassigned matter', async () => {
    const res = await request(app)
      .post(`/api/matters/${otherMatterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ templateId: activeTemplateId });

    expect(res.statusCode).toBe(403);
    const event = await latestAudit('forbidden_checklist_template_access', otherMatterId);
    expect(event).toBeDefined();
    parseSafeMetadata(event);
  });

  test('assistant cannot apply template', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ templateId: activeTemplateId });

    expect(res.statusCode).toBe(403);
  });

  test('client cannot apply template', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ templateId: activeTemplateId });

    expect(res.statusCode).toBe(403);
  });

  test('applying template creates ordered incomplete checklist items appended after existing positions', async () => {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `R17 Append Matter ${runId}`, assignedTo: advocateName });
    expect(matterRes.statusCode).toBe(200);
    const appendMatterId = matterRes.body.id;

    const manualItem = await request(app)
      .post(`/api/matters/${appendMatterId}/checklist-items`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `R17 Existing Checklist ${runId}`, position: 7 });
    expect(manualItem.statusCode).toBe(200);

    const applyRes = await request(app)
      .post(`/api/matters/${appendMatterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ templateId: activeTemplateId });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.body.map(item => item.title)).toEqual([
      `R17 Apply First ${runId}`,
      `R17 Apply Second ${runId}`,
    ]);
    expect(applyRes.body.map(item => item.position)).toEqual([8, 9]);
    expect(applyRes.body.every(item => Number(item.completed) === 0)).toBe(true);
  });

  test('applying inactive template is rejected', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ templateId: inactiveTemplateId });

    expect(res.statusCode).toBe(404);
  });

  test('applying template does not create tasks or deadlines', async () => {
    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `R17 No Task Deadline Matter ${runId}`, assignedTo: advocateName });
    expect(matterRes.statusCode).toBe(200);
    const checkMatterId = matterRes.body.id;

    const beforeTasks = await dbAll('SELECT * FROM tasks WHERE matterId=?', [checkMatterId]);
    const beforeDeadlines = await dbAll('SELECT * FROM deadlines WHERE matterId=?', [checkMatterId]);
    expect(beforeTasks).toHaveLength(0);
    expect(beforeDeadlines).toHaveLength(0);

    const applyRes = await request(app)
      .post(`/api/matters/${checkMatterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ templateId: activeTemplateId });
    expect(applyRes.statusCode).toBe(200);

    const afterTasks = await dbAll('SELECT * FROM tasks WHERE matterId=?', [checkMatterId]);
    const afterDeadlines = await dbAll('SELECT * FROM deadlines WHERE matterId=?', [checkMatterId]);
    expect(afterTasks).toHaveLength(0);
    expect(afterDeadlines).toHaveLength(0);
  });

  test('client matter detail still does not expose checklist items', async () => {
    const res = await request(app)
      .get(`/api/matters/${matterId}`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('checklistItems');
  });

  test('audit events are recorded with safe metadata for template lifecycle, apply, and forbidden access', async () => {
    const created = await latestAudit('checklist_template_created', activeTemplateId);
    const createdMetadata = parseSafeMetadata(created);
    expect(createdMetadata.templateId).toBe(activeTemplateId);

    const updated = await latestAudit('checklist_template_updated', activeTemplateId);
    const updatedMetadata = parseSafeMetadata(updated);
    expect(updatedMetadata.updatedFields).toContain('items');

    const deleted = await latestAudit('checklist_template_deleted', inactiveTemplateId);
    const deletedMetadata = parseSafeMetadata(deleted);
    expect(deletedMetadata.active).toBe(0);

    const applied = await latestAudit('matter_checklist_template_applied', activeTemplateId);
    const appliedMetadata = parseSafeMetadata(applied);
    expect(appliedMetadata.templateId).toBe(activeTemplateId);
    expect(appliedMetadata.itemCount).toBe(2);

    const forbidden = await latestAudit('forbidden_checklist_template_access', otherMatterId);
    const forbiddenMetadata = parseSafeMetadata(forbidden);
    expect(forbiddenMetadata.route).toBe('template_apply');
  });
});
