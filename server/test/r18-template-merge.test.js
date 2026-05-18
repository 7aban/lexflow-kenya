const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');
const { buildTemplateMergeContext, mergeTemplateMarkup } = require('../lib/templateMerge');

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

describe('R18-3 template merge helper', () => {
  test('1. replaces known tokens', () => {
    const context = buildTemplateMergeContext({
      firm: { name: 'Achoki & Co. Advocates' },
      matter: { title: 'Estate Succession', reference: 'LEX-2026-0001' },
      client: { name: 'Margaret Wairimu' },
      user: { fullName: 'Sarah Mwangi', role: 'advocate' },
      today: '2026-05-18',
    });

    const result = mergeTemplateMarkup(
      'Dear {{client.name}}, {{firm.name}} acts in {{matter.title}} ({{matter.reference}}) for {{user.fullName}}.',
      context,
    );

    expect(result.preview).toBe('Dear Margaret Wairimu, Achoki & Co. Advocates acts in Estate Succession (LEX-2026-0001) for Sarah Mwangi.');
    expect(result.tokens).toEqual(['client.name', 'firm.name', 'matter.title', 'matter.reference', 'user.fullName']);
    expect(result.unresolvedTokens).toEqual([]);
  });

  test('2. preserves line breaks', () => {
    const context = buildTemplateMergeContext({
      client: { name: 'Margaret Wairimu' },
      firm: { name: 'Achoki & Co. Advocates' },
    });

    const result = mergeTemplateMarkup('Dear {{client.name}},\n\nRegards,\n{{firm.name}}', context);

    expect(result.preview).toBe('Dear Margaret Wairimu,\n\nRegards,\nAchoki & Co. Advocates');
  });

  test('3. leaves unknown tokens visible and reports them', () => {
    const context = buildTemplateMergeContext({ client: { name: 'Margaret Wairimu' } });
    const result = mergeTemplateMarkup('Dear {{client.name}}, ref {{matter.unknownField}} {{missing}}.', context);

    expect(result.preview).toBe('Dear Margaret Wairimu, ref {{matter.unknownField}} {{missing}}.');
    expect(result.tokens).toEqual(['client.name', 'matter.unknownField', 'missing']);
    expect(result.unresolvedTokens).toEqual(['matter.unknownField', 'missing']);
  });

  test('4. does not evaluate unsafe-looking expressions', () => {
    const context = buildTemplateMergeContext({ client: { name: 'Margaret Wairimu' } });
    const input = 'Unsafe {{constructor.constructor("return process")()}} and safe {{client.name}}.';

    const result = mergeTemplateMarkup(input, context);

    expect(result.preview).toBe('Unsafe {{constructor.constructor("return process")()}} and safe Margaret Wairimu.');
    expect(result.unresolvedTokens).toEqual(['constructor.constructor("return process")()']);
  });
});

describe('R18-3 document template preview endpoint', () => {
  const runId = Date.now();
  const password = 'Str0ng!Passw0rd2026!';
  let adminToken;
  let advocateToken;
  let assistantToken;
  let unassignedAdvocateToken;
  let clientToken;
  let activeTemplateId;
  let inactiveTemplateId;
  let matterId;
  let firmName;
  let preCounts;
  let preTemplateRow;

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

    const unassignedEmail = `r18-merge-unassigned-${runId}@example.com`;
    const unassignedName = `R18 Merge Unassigned ${runId}`;
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

    const clientEmail = `r18-merge-client-${runId}@example.com`;
    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R18 Merge Client ${runId}`, email: clientEmail, phone: '+254700000000' });
    expect(clientRes.statusCode).toBe(200);
    const clientId = clientRes.body.id;

    const clientUserRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: clientEmail, password, fullName: `R18 Merge Client User ${runId}`, role: 'client', clientId });
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
        title: `R18 Merge Matter ${runId}`,
        reference: `R18-MERGE-${runId}`,
        practiceArea: 'Commercial Law',
        stage: 'Pleadings',
        assignedTo: 'Sarah Mwangi',
        court: 'Milimani Commercial Courts',
        caseNo: `COMM-${runId}`,
      });
    expect(matterRes.statusCode).toBe(200);
    matterId = matterRes.body.id;

    const templateRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `R18 Merge Template ${runId}`,
        description: 'Preview-only template.',
        practiceArea: 'Commercial Law',
        category: 'Letter',
        bodyMarkup: [
          'Dear {{client.name}},',
          '',
          '{{firm.name}} acts in {{matter.title}}.',
          'Reference: {{matter.reference}}',
          'Court: {{matter.court}}',
          'Case: {{matter.caseNo}}',
          'Area: {{matter.practiceArea}} / {{matter.stage}}',
          'Advocate: {{matter.assignedAdvocate}}',
          'Prepared by {{user.fullName}} ({{user.role}}) on {{today}}.',
          'Unresolved: {{matter.unmappedField}}',
        ].join('\n'),
      });
    expect(templateRes.statusCode).toBe(200);
    activeTemplateId = templateRes.body.id;

    const inactiveRes = await request(app)
      .post('/api/document-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `R18 Merge Inactive Template ${runId}`, bodyMarkup: 'Inactive {{client.name}}' });
    expect(inactiveRes.statusCode).toBe(200);
    inactiveTemplateId = inactiveRes.body.id;

    const deleteInactive = await request(app)
      .delete(`/api/document-templates/${inactiveTemplateId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteInactive.statusCode).toBe(200);

    const firmSettings = await dbGet('SELECT name FROM firm_settings WHERE id=?', ['default']);
    firmName = firmSettings?.name || '';
    expect(firmName).toBeTruthy();

    preCounts = await getGlobalSideEffectCounts();
    preTemplateRow = await dbGet('SELECT * FROM document_templates WHERE id=?', [activeTemplateId]);
  });

  async function preview(token, templateId = activeTemplateId) {
    return request(app)
      .post(`/api/matters/${matterId}/document-templates/${templateId}/preview`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  }

  test('1. admin can preview a template for a matter', async () => {
    const res = await preview(adminToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.templateId).toBe(activeTemplateId);
    expect(res.body.matterId).toBe(matterId);
    expect(res.body.preview).toContain(`Dear R18 Merge Client ${runId},`);
    expect(res.body.preview).toContain(`${firmName} acts in R18 Merge Matter ${runId}.`);
    expect(res.body.preview).toContain(`Reference: R18-MERGE-${runId}`);
    expect(res.body.preview).toContain('Court: Milimani Commercial Courts');
    expect(res.body.preview).toContain(`Case: COMM-${runId}`);
    expect(res.body.preview).toContain('Area: Commercial Law / Pleadings');
    expect(res.body.preview).toContain('Advocate: Sarah Mwangi');
    expect(res.body.preview).toContain('Prepared by Laban Achoki (admin)');
    expect(res.body.preview).toContain('Unresolved: {{matter.unmappedField}}');
    expect(res.body.tokens).toContain('client.name');
    expect(res.body.tokens).toContain('matter.unmappedField');
    expect(res.body.unresolvedTokens).toEqual(['matter.unmappedField']);
  });

  test('2. assigned advocate can preview for assigned matter', async () => {
    const res = await preview(advocateToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.preview).toContain('Prepared by Sarah Mwangi (advocate)');
    expect(res.body.preview).toContain('Advocate: Sarah Mwangi');
  });

  test('3. unassigned advocate cannot preview another advocate matter', async () => {
    const res = await preview(unassignedAdvocateToken);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/matter access denied/i);
  });

  test('4. assistant can preview according to current assistant matter access model', async () => {
    const res = await preview(assistantToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.preview).toContain('Prepared by David Wanjiku (assistant)');
  });

  test('5. client cannot preview', async () => {
    const res = await preview(clientToken);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/staff access required/i);
  });

  test('6. inactive template cannot be previewed', async () => {
    const res = await preview(adminToken, inactiveTemplateId);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/active document template/i);
  });

  test('7. missing template returns 404', async () => {
    const res = await preview(adminToken, `missing-template-${runId}`);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/active document template/i);
  });

  test('8. response includes tokens and unresolvedTokens arrays', async () => {
    const res = await preview(adminToken);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(Array.isArray(res.body.unresolvedTokens)).toBe(true);
    expect(res.body.tokens).toEqual(expect.arrayContaining([
      'firm.name',
      'matter.title',
      'matter.reference',
      'matter.court',
      'matter.caseNo',
      'matter.practiceArea',
      'matter.stage',
      'matter.assignedAdvocate',
      'client.name',
      'today',
      'user.fullName',
      'user.role',
      'matter.unmappedField',
    ]));
    expect(res.body.unresolvedTokens).toEqual(['matter.unmappedField']);
  });

  test('9. preview creates no rows in documents, tasks, deadlines, notifications, reminder_logs', async () => {
    const postCounts = await getGlobalSideEffectCounts();

    expect(postCounts).toEqual(preCounts);
  });

  test('10. preview does not mutate the document_template row', async () => {
    const postTemplateRow = await dbGet('SELECT * FROM document_templates WHERE id=?', [activeTemplateId]);

    expect(postTemplateRow).toEqual(preTemplateRow);
  });
});
