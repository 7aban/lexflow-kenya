const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

jest.setTimeout(15000);

function dbAll(sql, params = []) {
  const db = new sqlite3.Database(path.join(__dirname, '..', 'lawfirm.db'));
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      db.close();
      err ? reject(err) : resolve(rows);
    });
  });
}

async function dbGet(sql, params = []) {
  const rows = await dbAll(sql, params);
  return rows[0];
}

async function latestAuditEvent(action, entityId) {
  return dbGet(
    'SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1',
    [action, entityId || ''],
  );
}

async function latestLegacyAudit(action, entityType, entityId) {
  return dbGet(
    'SELECT * FROM audit_logs WHERE action=? AND entityType=? AND entityId=? ORDER BY createdAt DESC LIMIT 1',
    [action, entityType, entityId || ''],
  );
}

async function sideEffectCounts() {
  const [documents, tasks, deadlines, notifications, reminderLogs, folders, conversations, messages, notices] = await Promise.all([
    dbGet('SELECT COUNT(*) AS count FROM documents'),
    dbGet('SELECT COUNT(*) AS count FROM tasks'),
    dbGet('SELECT COUNT(*) AS count FROM deadlines'),
    dbGet('SELECT COUNT(*) AS count FROM notifications'),
    dbGet('SELECT COUNT(*) AS count FROM reminder_logs'),
    dbGet('SELECT COUNT(*) AS count FROM folders'),
    dbGet('SELECT COUNT(*) AS count FROM conversations'),
    dbGet('SELECT COUNT(*) AS count FROM messages'),
    dbGet('SELECT COUNT(*) AS count FROM firm_notices'),
  ]);
  return {
    documents: documents.count,
    tasks: tasks.count,
    deadlines: deadlines.count,
    notifications: notifications.count,
    reminderLogs: reminderLogs.count,
    folders: folders.count,
    conversations: conversations.count,
    messages: messages.count,
    notices: notices.count,
  };
}

function parseSafeMetadata(event) {
  expect(event).toBeDefined();
  const metadata = JSON.parse(event.metadata_json || '{}');
  const serialized = JSON.stringify(metadata).toLowerCase();
  for (const forbidden of [
    'authorization',
    'bearer',
    'password',
    'secret',
    'blob',
    'r18_generated_body_should_not_appear',
    'raw template',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
  return metadata;
}

describe('R18-4 generated draft persistence', () => {
  const runId = Date.now();
  const password = 'Str0ng!Passw0rd2026!';
  const bodySentinel = `R18_GENERATED_BODY_SHOULD_NOT_APPEAR_${runId}`;
  let adminToken;
  let advocateToken;
  let assistantToken;
  let unassignedAdvocateToken;
  let clientToken;
  let matterId;
  let templateId;
  let inactiveTemplateId;
  let templateName;
  let preCounts;
  let preTemplateRow;
  let adminDocumentId;
  let advocateDocumentId;

  beforeAll(async () => {
    await dbReady;

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminLogin.statusCode).toBe(200);
    adminToken = adminLogin.body.token;

    const advocateLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(advocateLogin.statusCode).toBe(200);
    advocateToken = advocateLogin.body.token;

    const assistantLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    expect(assistantLogin.statusCode).toBe(200);
    assistantToken = assistantLogin.body.token;

    const unassignedEmail = `r18-generation-unassigned-${runId}@example.com`;
    const unassignedName = `R18 Generation Unassigned ${runId}`;
    const unassignedRegister = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: unassignedEmail, password, fullName: unassignedName, role: 'advocate' });
    expect(unassignedRegister.statusCode).toBe(200);

    const unassignedLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: unassignedEmail, password });
    expect(unassignedLogin.statusCode).toBe(200);
    unassignedAdvocateToken = unassignedLogin.body.token;

    const clientEmail = `r18-generation-client-${runId}@example.com`;
    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R18 Generation Client ${runId}`, email: clientEmail, phone: '+254700000000' });
    expect(clientRes.statusCode).toBe(200);
    const clientId = clientRes.body.id;

    const clientUserRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: clientEmail, password, fullName: `R18 Generation Client User ${runId}`, role: 'client', clientId });
    expect(clientUserRes.statusCode).toBe(200);

    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientEmail, password });
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;

    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId,
        title: `R18 Generation Matter ${runId}`,
        reference: `R18-GEN-${runId}`,
        practiceArea: 'Commercial Law',
        stage: 'Drafting',
        assignedTo: 'Sarah Mwangi',
        court: 'Milimani Commercial Courts',
        caseNo: `GEN-${runId}`,
      });
    expect(matterRes.statusCode).toBe(200);
    matterId = matterRes.body.id;

    templateName = `R18 Generation Template ${runId}`;
    const templateRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: templateName,
        description: 'Generated draft persistence template.',
        practiceArea: 'Commercial Law',
        category: 'Draft',
        bodyMarkup: [
          'Dear {{client.name}},',
          '',
          `Generated body marker ${bodySentinel}`,
          '{{firm.name}} acts in {{matter.title}}.',
          'Reference: {{matter.reference}}',
          'Prepared by {{user.fullName}} ({{user.role}}).',
          'Unresolved: {{matter.unmappedField}}',
        ].join('\n'),
      });
    expect(templateRes.statusCode).toBe(200);
    templateId = templateRes.body.id;

    const inactiveTemplateRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R18 Generation Inactive Template ${runId}`, bodyMarkup: 'Inactive {{client.name}}' });
    expect(inactiveTemplateRes.statusCode).toBe(200);
    inactiveTemplateId = inactiveTemplateRes.body.id;

    const deleteInactive = await request(app)
      .delete(`/api/document-templates/${inactiveTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteInactive.statusCode).toBe(200);

    preCounts = await sideEffectCounts();
    preTemplateRow = await dbGet('SELECT * FROM document_templates WHERE id=?', [templateId]);
  });

  async function generate(token, selectedTemplateId = templateId) {
    return request(app)
      .post(`/api/matters/${matterId}/document-templates/${selectedTemplateId}/generate`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  }

  test('1. admin can generate a draft and receives public metadata only', async () => {
    const before = await dbGet('SELECT COUNT(*) AS count FROM documents');
    const res = await generate(adminToken);
    const after = await dbGet('SELECT COUNT(*) AS count FROM documents');

    expect(res.statusCode).toBe(200);
    expect(after.count).toBe(before.count + 1);
    expect(res.body.id).toMatch(/^DOC/);
    expect(res.body.matterId).toBe(matterId);
    expect(res.body.source).toBe('generated');
    expect(res.body.mimeType).toBe('text/plain');
    expect(res.body.type).toBe('Text');
    expect(Number(res.body.clientVisible)).toBe(0);
    expect(res.body.templateId).toBe(templateId);
    expect(res.body.templateName).toBe(templateName);
    expect(res.body.generatedBy).toBeTruthy();
    expect(res.body.generatedAt).toBeTruthy();
    expect(Number(res.body.version)).toBe(1);
    expect(res.body.unresolvedTokens).toEqual(['matter.unmappedField']);
    expect(res.body.content).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(bodySentinel);
    adminDocumentId = res.body.id;
  });

  test('2. assigned advocate can generate a draft for an assigned matter', async () => {
    const res = await generate(advocateToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toMatch(/^DOC/);
    expect(res.body.source).toBe('generated');
    expect(res.body.templateId).toBe(templateId);
    expect(res.body.generatedBy).toContain('Sarah Mwangi');
    advocateDocumentId = res.body.id;
  });

  test('3. generated document row has expected persisted fields and merged content', async () => {
    const row = await dbGet('SELECT * FROM documents WHERE id=?', [adminDocumentId]);

    expect(row).toBeDefined();
    expect(row.source).toBe('generated');
    expect(Number(row.clientVisible)).toBe(0);
    expect(row.mimeType).toBe('text/plain');
    expect(row.type).toBe('Text');
    expect(row.folderId).toBeNull();
    expect(row.templateId).toBe(templateId);
    expect(row.templateName).toBe(templateName);
    expect(row.generatedBy).toBeTruthy();
    expect(row.generatedAt).toBeTruthy();
    expect(Number(row.version)).toBe(1);
    expect(row.uploadedBy).toBe(row.generatedBy);
    expect(row.name).toMatch(/\.txt$/);
    expect(row.displayName).toMatch(/\.txt$/);
    expect(row.content).toBeInstanceOf(Buffer);
    const text = row.content.toString('utf8');
    expect(text).toContain(`R18 Generation Client ${runId}`);
    expect(text).toContain(`R18 Generation Matter ${runId}`);
    expect(text).toContain(`Generated body marker ${bodySentinel}`);
    expect(text).toContain('{{matter.unmappedField}}');
  });

  test('4. assistant, unassigned advocate, and client cannot generate', async () => {
    const assistantRes = await generate(assistantToken);
    expect(assistantRes.statusCode).toBe(403);
    expect(assistantRes.body.error).toMatch(/generation access denied/i);

    const unassignedRes = await generate(unassignedAdvocateToken);
    expect(unassignedRes.statusCode).toBe(403);
    expect(unassignedRes.body.error).toMatch(/generation access denied/i);

    const clientRes = await generate(clientToken);
    expect(clientRes.statusCode).toBe(403);
    expect(clientRes.body.error).toMatch(/staff access required/i);

    const forbidden = await latestAuditEvent('forbidden_document_generation', matterId);
    const metadata = parseSafeMetadata(forbidden);
    expect(metadata.route).toBe('document_template_generate');
    expect(metadata.templateId).toBe(templateId);
  });

  test('5. generated draft is hidden from client until staff toggles visibility', async () => {
    const hiddenList = await request(app)
      .get(`/api/matters/${matterId}/documents`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(hiddenList.statusCode).toBe(200);
    expect(hiddenList.body.find(doc => doc.id === adminDocumentId)).toBeUndefined();

    const hiddenDownload = await request(app)
      .get(`/api/documents/${adminDocumentId}/download`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(hiddenDownload.statusCode).toBe(403);

    const toggle = await request(app)
      .patch(`/api/documents/${adminDocumentId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientVisible: true });
    expect(toggle.statusCode).toBe(200);
    expect(Number(toggle.body.clientVisible)).toBe(1);

    const visibleList = await request(app)
      .get(`/api/matters/${matterId}/documents`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(visibleList.statusCode).toBe(200);
    expect(visibleList.body.find(doc => doc.id === adminDocumentId)).toBeDefined();

    const visibleDownload = await request(app)
      .get(`/api/documents/${adminDocumentId}/download`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(visibleDownload.statusCode).toBe(200);
    expect(visibleDownload.headers['content-type']).toContain('text/plain');
    expect(visibleDownload.text).toContain(bodySentinel);
  });

  test('6. inactive and missing templates cannot generate', async () => {
    const inactive = await generate(adminToken, inactiveTemplateId);
    expect(inactive.statusCode).toBe(404);
    expect(inactive.body.error).toMatch(/active document template/i);

    const missing = await generate(adminToken, `missing-template-${runId}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error).toMatch(/active document template/i);
  });

  test('7. generation does not mutate the document template row', async () => {
    const postTemplateRow = await dbGet('SELECT * FROM document_templates WHERE id=?', [templateId]);

    expect(postTemplateRow).toEqual(preTemplateRow);
  });

  test('8. generation has no non-document side effects', async () => {
    const postCounts = await sideEffectCounts();

    expect(postCounts.documents).toBe(preCounts.documents + 2);
    expect(postCounts.tasks).toBe(preCounts.tasks);
    expect(postCounts.deadlines).toBe(preCounts.deadlines);
    expect(postCounts.notifications).toBe(preCounts.notifications);
    expect(postCounts.reminderLogs).toBe(preCounts.reminderLogs);
    expect(postCounts.folders).toBe(preCounts.folders);
    expect(postCounts.conversations).toBe(preCounts.conversations);
    expect(postCounts.messages).toBe(preCounts.messages);
    expect(postCounts.notices).toBe(preCounts.notices);
  });

  test('9. document generation audit and legacy audit entries are recorded safely', async () => {
    const event = await latestAuditEvent('document_generated', adminDocumentId);
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document');
    expect(event.entity_id).toBe(adminDocumentId);
    expect(event.matter_id).toBe(matterId);
    const metadata = parseSafeMetadata(event);
    expect(metadata.matterId).toBe(matterId);
    expect(metadata.templateId).toBe(templateId);
    expect(metadata.templateName).toBe(templateName);
    expect(metadata.documentId).toBe(adminDocumentId);
    expect(metadata.outputFormat).toBe('text/plain');
    expect(metadata.bodyLength).toBeGreaterThan(0);
    expect(metadata.contentLength).toBeGreaterThan(0);
    expect(metadata.unresolvedTokenCount).toBe('[REDACTED]');
    expect(metadata.clientVisible).toBe(0);
    expect(metadata.source).toBe('generated');

    const legacy = await latestLegacyAudit('generate', 'document', adminDocumentId);
    expect(legacy).toBeDefined();
    expect(legacy.summary).toMatch(/generated draft document/i);
  });

  test('10. assigned advocate generation also persists exactly one generated row', async () => {
    const row = await dbGet('SELECT * FROM documents WHERE id=?', [advocateDocumentId]);

    expect(row).toBeDefined();
    expect(row.source).toBe('generated');
    expect(Number(row.clientVisible)).toBe(0);
    expect(row.templateId).toBe(templateId);
    expect(row.content.toString('utf8')).toContain('Prepared by Sarah Mwangi (advocate).');
  });
});
