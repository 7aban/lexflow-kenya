const request = require('supertest');
const sqlite3 = require('sqlite3');
const path = require('path');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

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
async function count(table) {
  const row = await dbGet(`SELECT COUNT(*) AS c FROM ${table}`);
  return row.c;
}
async function latestAuditEvent(action, entityId) {
  return dbGet('SELECT * FROM audit_events WHERE action=? AND entity_id=? ORDER BY timestamp DESC LIMIT 1', [action, entityId || '']);
}

// Sensitive sentinels that must NEVER appear in generated content / responses / audit.
const NOTES_SENTINEL = 'RETAINER_SECRET_NOTES_DO_NOT_LEAK';
const KYC_ID_SENTINEL = 'KYCPII_IDNUMBER_DO_NOT_LEAK';
const KYC_PIN_SENTINEL = 'KRAPIN_DO_NOT_LEAK';
const AUTH_EMAIL_SENTINEL = 'authsecret@hidden.example';
const AUTH_PHONE_SENTINEL = '+254700999888';
const LIFECYCLE_SUMMARY_SENTINEL = 'LIFECYCLE_SUMMARY_DO_NOT_LEAK';
const LIFECYCLE_REASON_SENTINEL = 'LIFECYCLE_REASON_DO_NOT_LEAK';

const TEMPLATE_BODY = [
  'Retainer agreement for {{client.name}} prepared by {{firm.name}}.',
  'Matter: {{matter.title}} ({{matter.reference}})',
  'RetainerStatus={{retainer.status}}; EngagementType={{retainer.engagementType}}',
  'Scope={{retainer.scopeSummary}}',
  'Exclusions={{retainer.exclusionsSummary}}',
  'Billing={{retainer.billingArrangementSummary}}',
  'RetainerNotesToken={{retainer.notes}}',
  'Fee={{feePlan.feeType}}/{{feePlan.status}}/{{feePlan.currency}}/{{feePlan.estimatedAmount}}',
  'KYC={{kyc.status}}/{{kyc.clientCategory}}/{{kyc.riskLevel}}',
  'KYCPII={{kyc.idNumber}}|{{kyc.kraPin}}|{{kyc.sourceOfFundsSummary}}',
  'Authority={{authority.status}}/{{authority.authorityBasis}}/{{authority.authorisedPersonName}}/{{authority.authorisedPersonRole}}',
  'AuthContact={{authority.authorisedPersonEmail}}|{{authority.authorisedPersonPhone}}',
  'Lifecycle={{lifecycle.eventType}}/{{lifecycle.status}}/{{lifecycle.title}}',
  'LifecycleText={{lifecycle.summary}}|{{lifecycle.reason}}|{{lifecycle.scopeBeforeSummary}}',
  'Prepared by {{user.fullName}} ({{user.role}}).',
].join('\n');

describe('RET-31J retainer document generator', () => {
  const runId = Date.now();
  const password = 'Str0ng!Passw0rd2026!';
  let adminToken, advocateToken, assistantToken, unassignedAdvocateToken, clientToken;
  let clientId, matterId, otherClientId, otherMatterId;
  let retainerId, retainerNoMatterId, inactiveRetainerId;
  let templateId, inactiveTemplateId, templateName;
  let preRows = {};

  async function setModules(mods) {
    return request(app).put('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`).send({ moduleSettings: mods });
  }

  beforeAll(async () => {
    await dbReady;

    adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' })).body.token;
    advocateToken = (await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' })).body.token;
    assistantToken = (await request(app).post('/api/auth/login').send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' })).body.token;

    // Enable all modules used by the merge context (we toggle some off later).
    await setModules({ retainerManagement: true, kycCdd: true, corporateAuthority: true, scopeVariation: true });

    // Unassigned advocate.
    const unassignedEmail = `ret31j-unassigned-${runId}@example.com`;
    await request(app).post('/api/auth/register').set('Authorization', `Bearer ${adminToken}`)
      .send({ email: unassignedEmail, password, fullName: `RET31J Unassigned ${runId}`, role: 'advocate' });
    unassignedAdvocateToken = (await request(app).post('/api/auth/login').send({ email: unassignedEmail, password })).body.token;

    // Primary client + matter assigned to Sarah Mwangi.
    const clientEmail = `ret31j-client-${runId}@example.com`;
    clientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `RET31J Client ${runId}`, email: clientEmail, phone: '+254700000001' })).body.id;
    await request(app).post('/api/auth/register').set('Authorization', `Bearer ${adminToken}`)
      .send({ email: clientEmail, password, fullName: `RET31J Client User ${runId}`, role: 'client', clientId });
    clientToken = (await request(app).post('/api/auth/client-login').send({ email: clientEmail, password })).body.token;

    matterId = (await request(app).post('/api/matters').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `RET31J Matter ${runId}`, reference: `RET31J-${runId}`, practiceArea: 'Commercial Law', stage: 'Drafting', assignedTo: 'Sarah Mwangi' })).body.id;

    // A second client+matter NOT belonging to the primary client (for cross-client test).
    const otherEmail = `ret31j-other-${runId}@example.com`;
    otherClientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `RET31J Other ${runId}`, email: otherEmail, phone: '+254700000002' })).body.id;
    otherMatterId = (await request(app).post('/api/matters').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: otherClientId, title: `RET31J Other Matter ${runId}`, reference: `RET31J-OTH-${runId}`, stage: 'Open', assignedTo: 'Sarah Mwangi' })).body.id;

    // Retainer linked to matter, with secret notes.
    retainerId = (await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId, matterId, status: 'draft', engagementType: 'litigation',
      scopeSummary: 'Represent in commercial dispute', exclusionsSummary: 'No appeals',
      billingArrangementSummary: 'Monthly billing', notes: NOTES_SENTINEL,
    })).body.id;

    // Retainer with NO matter (for matter-resolution tests).
    retainerNoMatterId = (await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId, status: 'draft', engagementType: 'advisory', scopeSummary: 'Advisory only',
    })).body.id;

    // Inactive retainer.
    inactiveRetainerId = (await request(app).post('/api/retainers').set('Authorization', `Bearer ${adminToken}`).send({
      clientId, status: 'draft',
    })).body.id;
    await request(app).delete(`/api/retainers/${inactiveRetainerId}`).set('Authorization', `Bearer ${adminToken}`);

    // Fee plan, KYC (with PII), authority (with contact), lifecycle (with free text).
    await request(app).post('/api/matter-fee-plans').set('Authorization', `Bearer ${adminToken}`).send({
      clientId, matterId, feeType: 'fixed', status: 'proposed', currency: 'KES', estimatedAmount: 150000,
    });
    await request(app).post('/api/client-kyc').set('Authorization', `Bearer ${adminToken}`).send({
      clientId, status: 'verified', clientCategory: 'individual', riskLevel: 'low',
      idNumber: KYC_ID_SENTINEL, kraPin: KYC_PIN_SENTINEL, sourceOfFundsSummary: 'salary secret', verifiedBy: 'Officer Secret',
    });
    await request(app).post('/api/client-authorities').set('Authorization', `Bearer ${adminToken}`).send({
      clientId, status: 'confirmed', authorityBasis: 'board_resolution', authorisedPersonName: 'Jane Director', authorisedPersonRole: 'CEO',
      authorisedPersonEmail: AUTH_EMAIL_SENTINEL, authorisedPersonPhone: AUTH_PHONE_SENTINEL, notes: 'authority secret note',
    });
    await request(app).post('/api/retainer-lifecycle-events').set('Authorization', `Bearer ${adminToken}`).send({
      clientId, matterId, eventType: 'scope_variation', status: 'recorded', title: 'Scope change one',
      summary: LIFECYCLE_SUMMARY_SENTINEL, reason: LIFECYCLE_REASON_SENTINEL, scopeBeforeSummary: 'before secret',
    });

    // Document template referencing all namespaces.
    templateName = `RET31J Template ${runId}`;
    templateId = (await request(app).post('/api/document-templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: templateName, practiceArea: 'Commercial Law', category: 'Retainer', bodyMarkup: TEMPLATE_BODY })).body.id;

    inactiveTemplateId = (await request(app).post('/api/document-templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `RET31J Inactive ${runId}`, bodyMarkup: 'X {{client.name}}' })).body.id;
    await request(app).delete(`/api/document-templates/${inactiveTemplateId}`).set('Authorization', `Bearer ${adminToken}`);

    preRows = {
      retainer: await dbGet('SELECT * FROM retainer_records WHERE id=?', [retainerId]),
      feePlan: await dbGet('SELECT * FROM matter_fee_plans WHERE clientId=? ORDER BY createdAt DESC LIMIT 1', [clientId]),
      kyc: await dbGet('SELECT * FROM client_kyc_records WHERE clientId=? ORDER BY createdAt DESC LIMIT 1', [clientId]),
      authority: await dbGet('SELECT * FROM client_authority_records WHERE clientId=? ORDER BY createdAt DESC LIMIT 1', [clientId]),
      lifecycle: await dbGet('SELECT * FROM retainer_lifecycle_events WHERE clientId=? ORDER BY createdAt DESC LIMIT 1', [clientId]),
      invoices: await count('invoices'),
      payments: await count('payments'),
      ledger: await count('retainer_ledger_entries'),
      timeEntries: await count('time_entries'),
    };
  });

  function gen(token, id, body = {}) {
    return request(app).post(`/api/retainers/${id}/generate-document`).set('Authorization', `Bearer ${token}`).send(body);
  }

  test('1. retainerManagement disabled returns 403 feature_disabled', async () => {
    await setModules({ retainerManagement: false });
    const res = await gen(adminToken, retainerId, { templateId });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('feature_disabled');
    await setModules({ retainerManagement: true });
  });

  test('2. admin can generate; returns public document only, no content', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    expect(res.statusCode).toBe(201);
    expect(res.body.document.id).toMatch(/^DOC/);
    expect(res.body.document.matterId).toBe(matterId);
    expect(res.body.document.source).toBe('generated');
    expect(res.body.document.mimeType).toBe('text/plain');
    expect(res.body.document.type).toBe('Text');
    expect(Number(res.body.document.clientVisible)).toBe(0);
    expect(res.body.document.content).toBeUndefined();
    expect(Array.isArray(res.body.unresolvedTokens)).toBe(true);
    // No sensitive sentinels in the response body.
    const serialized = JSON.stringify(res.body);
    for (const s of [NOTES_SENTINEL, KYC_ID_SENTINEL, KYC_PIN_SENTINEL, AUTH_EMAIL_SENTINEL, AUTH_PHONE_SENTINEL, LIFECYCLE_SUMMARY_SENTINEL]) {
      expect(serialized).not.toContain(s);
    }
  });

  test('3. assistant can generate retainer document', async () => {
    const res = await gen(assistantToken, retainerId, { templateId });
    expect(res.statusCode).toBe(201);
    expect(res.body.document.source).toBe('generated');
  });

  test('4. assigned advocate can generate retainer document', async () => {
    const res = await gen(advocateToken, retainerId, { templateId });
    expect(res.statusCode).toBe(201);
    expect(res.body.document.generatedBy).toContain('Sarah Mwangi');
  });

  test('5. unassigned advocate gets 403', async () => {
    const res = await gen(unassignedAdvocateToken, retainerId, { templateId });
    expect(res.statusCode).toBe(403);
    const forbidden = await latestAuditEvent('forbidden_retainer_document_generation', retainerId);
    expect(forbidden).toBeDefined();
  });

  test('6. client gets 403', async () => {
    const res = await gen(clientToken, retainerId, { templateId });
    expect(res.statusCode).toBe(403);
  });

  test('7. missing retainer returns 404', async () => {
    const res = await gen(adminToken, `missing-${runId}`, { templateId });
    expect(res.statusCode).toBe(404);
  });

  test('8. inactive retainer rejected (400)', async () => {
    const res = await gen(adminToken, inactiveRetainerId, { templateId });
    expect(res.statusCode).toBe(400);
  });

  test('9. missing templateId rejected (400)', async () => {
    const res = await gen(adminToken, retainerId, {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/templateId/i);
  });

  test('10. missing/inactive template returns 404', async () => {
    const missing = await gen(adminToken, retainerId, { templateId: `nope-${runId}` });
    expect(missing.statusCode).toBe(404);
    const inactive = await gen(adminToken, retainerId, { templateId: inactiveTemplateId });
    expect(inactive.statusCode).toBe(404);
  });

  test('11. retainer with no matter and no body matterId returns 400', async () => {
    const res = await gen(adminToken, retainerNoMatterId, { templateId });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/matterId is required/i);
  });

  test('12. body matterId must belong to retainer client', async () => {
    const res = await gen(adminToken, retainerNoMatterId, { templateId, matterId: otherMatterId });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);
  });

  test('12b. retainer with no matter generates when given a valid same-client matter', async () => {
    const res = await gen(adminToken, retainerNoMatterId, { templateId, matterId });
    expect(res.statusCode).toBe(201);
    expect(res.body.document.matterId).toBe(matterId);
  });

  test('13. advocate must be able to access selected matter (unassigned matter -> 403)', async () => {
    // Reassign primary matter away from Sarah so she can no longer access it.
    await request(app).patch(`/api/matters/${matterId}`).set('Authorization', `Bearer ${adminToken}`).send({ assignedTo: 'Unassigned Person' });
    const res = await gen(advocateToken, retainerId, { templateId });
    expect(res.statusCode).toBe(403);
    // Restore assignment.
    await request(app).patch(`/api/matters/${matterId}`).set('Authorization', `Bearer ${adminToken}`).send({ assignedTo: 'Sarah Mwangi' });
  });

  test('14. saved document has expected persisted fields', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    const row = await dbGet('SELECT * FROM documents WHERE id=?', [res.body.document.id]);
    expect(row.matterId).toBe(matterId);
    expect(row.source).toBe('generated');
    expect(row.mimeType).toBe('text/plain');
    expect(row.type).toBe('Text');
    expect(Number(row.clientVisible)).toBe(0);
    expect(row.templateId).toBe(templateId);
    expect(row.templateName).toBe(templateName);
    expect(row.generatedBy).toBeTruthy();
    expect(row.generatedAt).toBeTruthy();
    expect(Number(row.version)).toBe(1);
    expect(row.name).toMatch(/\.txt$/);
  });

  test('15. explicit clientVisible true honored for admin, downgraded for assistant', async () => {
    const adminRes = await gen(adminToken, retainerId, { templateId, clientVisible: true });
    expect(Number(adminRes.body.document.clientVisible)).toBe(1);
    const assistantRes = await gen(assistantToken, retainerId, { templateId, clientVisible: true });
    expect(Number(assistantRes.body.document.clientVisible)).toBe(0);
  });

  test('16. response returns public document only and no content field', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    expect(res.body.document.content).toBeUndefined();
    expect(res.body).not.toHaveProperty('content');
  });

  test('17. generated DB content includes retainer/fee/kyc/authority/lifecycle safe merge values', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    const row = await dbGet('SELECT content FROM documents WHERE id=?', [res.body.document.id]);
    const text = row.content.toString('utf8');
    expect(text).toContain('RetainerStatus=draft');
    expect(text).toContain('EngagementType=litigation');
    expect(text).toContain('Represent in commercial dispute');
    expect(text).toContain('Fee=fixed/proposed/KES/150000');
    expect(text).toContain('KYC=verified/individual/low');
    expect(text).toContain('Authority=confirmed/board_resolution/Jane Director/CEO');
    expect(text).toContain('Lifecycle=scope_variation/recorded/Scope change one');
    expect(text).toContain(`RET31J Client ${runId}`);
  });

  test('18. retainer notes are not merged/exposed in content', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    const row = await dbGet('SELECT content FROM documents WHERE id=?', [res.body.document.id]);
    const text = row.content.toString('utf8');
    expect(text).not.toContain(NOTES_SENTINEL);
    // The notes token has no resolvable value, so it remains a literal placeholder.
    expect(text).toContain('RetainerNotesToken={{retainer.notes}}');
  });

  test('19/20. KYC safe tokens populate only when kycCdd enabled; PII never present', async () => {
    // Enabled: safe KYC value present, PII absent.
    const onRes = await gen(adminToken, retainerId, { templateId });
    const onText = (await dbGet('SELECT content FROM documents WHERE id=?', [onRes.body.document.id])).content.toString('utf8');
    expect(onText).toContain('KYC=verified/individual/low');
    expect(onText).not.toContain(KYC_ID_SENTINEL);
    expect(onText).not.toContain(KYC_PIN_SENTINEL);
    expect(onText).toContain('KYCPII={{kyc.idNumber}}|{{kyc.kraPin}}|{{kyc.sourceOfFundsSummary}}');

    // Disabled: KYC namespace resolves blank (no leak, not blocked).
    await setModules({ kycCdd: false });
    const offRes = await gen(adminToken, retainerId, { templateId });
    expect(offRes.statusCode).toBe(201);
    const offText = (await dbGet('SELECT content FROM documents WHERE id=?', [offRes.body.document.id])).content.toString('utf8');
    expect(offText).toContain('KYC=//');
    expect(offText).not.toContain(KYC_ID_SENTINEL);
    await setModules({ kycCdd: true });
  });

  test('21. authority safe tokens populate only when corporateAuthority enabled', async () => {
    const onRes = await gen(adminToken, retainerId, { templateId });
    const onText = (await dbGet('SELECT content FROM documents WHERE id=?', [onRes.body.document.id])).content.toString('utf8');
    expect(onText).toContain('Authority=confirmed/board_resolution/Jane Director/CEO');

    await setModules({ corporateAuthority: false });
    const offRes = await gen(adminToken, retainerId, { templateId });
    const offText = (await dbGet('SELECT content FROM documents WHERE id=?', [offRes.body.document.id])).content.toString('utf8');
    expect(offText).toContain('Authority=///');
    expect(offText).not.toContain('Jane Director');
    await setModules({ corporateAuthority: true });
  });

  test('22. authority contact details never present in content or audit metadata', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    const text = (await dbGet('SELECT content FROM documents WHERE id=?', [res.body.document.id])).content.toString('utf8');
    expect(text).not.toContain(AUTH_EMAIL_SENTINEL);
    expect(text).not.toContain(AUTH_PHONE_SENTINEL);
    const event = await latestAuditEvent('retainer_document_generated', res.body.document.id);
    expect(event.metadata_json).not.toContain(AUTH_EMAIL_SENTINEL);
    expect(event.metadata_json).not.toContain(AUTH_PHONE_SENTINEL);
  });

  test('23. lifecycle safe tokens populate only when scopeVariation enabled', async () => {
    const onRes = await gen(adminToken, retainerId, { templateId });
    const onText = (await dbGet('SELECT content FROM documents WHERE id=?', [onRes.body.document.id])).content.toString('utf8');
    expect(onText).toContain('Lifecycle=scope_variation/recorded/Scope change one');

    await setModules({ scopeVariation: false });
    const offRes = await gen(adminToken, retainerId, { templateId });
    const offText = (await dbGet('SELECT content FROM documents WHERE id=?', [offRes.body.document.id])).content.toString('utf8');
    expect(offText).toContain('Lifecycle=//');
    expect(offText).not.toContain('Scope change one');
    await setModules({ scopeVariation: true });
  });

  test('24. lifecycle free text never present in content or audit metadata', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    const text = (await dbGet('SELECT content FROM documents WHERE id=?', [res.body.document.id])).content.toString('utf8');
    expect(text).not.toContain(LIFECYCLE_SUMMARY_SENTINEL);
    expect(text).not.toContain(LIFECYCLE_REASON_SENTINEL);
    const event = await latestAuditEvent('retainer_document_generated', res.body.document.id);
    expect(event.metadata_json).not.toContain(LIFECYCLE_SUMMARY_SENTINEL);
    expect(event.metadata_json).not.toContain(LIFECYCLE_REASON_SENTINEL);
  });

  test('25. audit event retainer_document_generated created with whitelist metadata', async () => {
    const res = await gen(adminToken, retainerId, { templateId, filename: 'My Retainer' });
    const event = await latestAuditEvent('retainer_document_generated', res.body.document.id);
    expect(event).toBeDefined();
    expect(event.entity_type).toBe('document');
    expect(event.matter_id).toBe(matterId);
    expect(event.client_id).toBe(clientId);
    const meta = JSON.parse(event.metadata_json);
    expect(meta.retainerId).toBe(retainerId);
    expect(meta.clientId).toBe(clientId);
    expect(meta.matterId).toBe(matterId);
    expect(meta.templateId).toBe(templateId);
    expect(meta.templateName).toBe(templateName);
    expect(meta.documentId).toBe(res.body.document.id);
    expect(meta.filename).toMatch(/My Retainer\.txt$/);
    expect(meta.clientVisible).toBe(0);
    expect(meta.source).toBe('retainer_document_generator');
    expect(meta).toHaveProperty('contentLength');
  });

  test('26. audit metadata excludes content, template body, retainer free text, KYC PII, authority/lifecycle text', async () => {
    const res = await gen(adminToken, retainerId, { templateId });
    const event = await latestAuditEvent('retainer_document_generated', res.body.document.id);
    const raw = event.metadata_json;
    for (const s of [
      NOTES_SENTINEL, KYC_ID_SENTINEL, KYC_PIN_SENTINEL, AUTH_EMAIL_SENTINEL, AUTH_PHONE_SENTINEL,
      LIFECYCLE_SUMMARY_SENTINEL, LIFECYCLE_REASON_SENTINEL,
      'Represent in commercial dispute', 'RetainerNotesToken', 'Prepared by',
    ]) {
      expect(raw).not.toContain(s);
    }
  });

  test('27-31. generation does not mutate retainer/feePlan/kyc/authority/lifecycle rows', async () => {
    await gen(adminToken, retainerId, { templateId });
    expect(await dbGet('SELECT * FROM retainer_records WHERE id=?', [retainerId])).toEqual(preRows.retainer);
    expect(await dbGet('SELECT * FROM matter_fee_plans WHERE id=?', [preRows.feePlan.id])).toEqual(preRows.feePlan);
    expect(await dbGet('SELECT * FROM client_kyc_records WHERE id=?', [preRows.kyc.id])).toEqual(preRows.kyc);
    expect(await dbGet('SELECT * FROM client_authority_records WHERE id=?', [preRows.authority.id])).toEqual(preRows.authority);
    expect(await dbGet('SELECT * FROM retainer_lifecycle_events WHERE id=?', [preRows.lifecycle.id])).toEqual(preRows.lifecycle);
  });

  test('32. no invoice/payment/ledger/time-entry rows created or mutated', async () => {
    await gen(adminToken, retainerId, { templateId });
    expect(await count('invoices')).toBe(preRows.invoices);
    expect(await count('payments')).toBe(preRows.payments);
    expect(await count('retainer_ledger_entries')).toBe(preRows.ledger);
    expect(await count('time_entries')).toBe(preRows.timeEntries);
  });
});
