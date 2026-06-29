// LOCAL-PILOT-FIX-10 — client intake + KYC/retainer onboarding triggers.
//
// The UI change for this phase is frontend-only (clearer intake labels and a
// post-create next-step prompt in client/src/views/StaffViews.jsx). This suite
// pins down the backend contract that the new UI relies on:
// 1. POST /api/clients works for Individual and Company clients, with contact
//    optional and phone persisted, and the response shape unchanged.
// 2. Module toggles (kycCdd / retainerManagement) can be flipped via
//    PUT /api/firm-settings without breaking client creation.
// 3. The workflows the post-create prompt buttons lead into already exist:
//    POST /api/client-kyc and POST /api/retainers succeed for a just-created
//    client when their modules are enabled, and are refused (403
//    feature_disabled) when disabled — the prompt is hidden in that case.
// 4. Matter creation still accepts solDate (storage name unchanged) and
//    coerces string billingRate/fixedFee values, which the retyped Rate/Fee
//    input now submits.
const request = require('supertest');
const { app } = require('../server.js');

const INDIVIDUAL_NAME = 'LP-FIX10 John Kamau';
const COMPANY_NAME = 'LP-FIX10 ABC Limited';
const COMPANY_CONTACT = 'Jane Wanjiku, Legal Officer';
const PHONE = '0712 345 678';

let adminToken;
let originalModules = {};
let individualId;
let companyId;
let matterId;
let kycRecordId;
let retainerId;

async function setModules(modules) {
  const res = await request(app)
    .put('/api/firm-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ moduleSettings: modules });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = login.body.token;
  expect(adminToken).toBeDefined();

  const settings = await request(app)
    .get('/api/firm-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(settings.statusCode).toBe(200);
  originalModules = {
    kycCdd: Boolean(settings.body.moduleSettings?.kycCdd),
    retainerManagement: Boolean(settings.body.moduleSettings?.retainerManagement),
  };
});

afterAll(async () => {
  // Tidy up records this suite created, then restore the firm's module toggles.
  if (kycRecordId) {
    await request(app).delete(`/api/client-kyc/${kycRecordId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  if (retainerId) {
    await request(app).delete(`/api/retainers/${retainerId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  if (matterId) {
    await request(app).delete(`/api/matters/${matterId}`).set('Authorization', `Bearer ${adminToken}`);
  }
  for (const id of [individualId, companyId].filter(Boolean)) {
    await request(app).delete(`/api/clients/${id}`).set('Authorization', `Bearer ${adminToken}`);
  }
  await setModules(originalModules);
});

describe('client creation (intake contract unchanged)', () => {
  test('individual client can be created with contact left blank', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: INDIVIDUAL_NAME, type: 'Individual', email: '', phone: PHONE });
    expect(res.statusCode).toBe(200);
    individualId = res.body.id;
    expect(res.body.name).toBe(INDIVIDUAL_NAME);
    expect(res.body.type).toBe('Individual');
    expect(res.body.contact).toBe('');
    expect(res.body.phone).toBe(PHONE);
    expect(res.body.status).toBe('Active');
  });

  test('company client can be created with a primary contact person', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: COMPANY_NAME, type: 'Company', contact: COMPANY_CONTACT, phone: PHONE });
    expect(res.statusCode).toBe(200);
    companyId = res.body.id;
    expect(res.body.type).toBe('Company');
    expect(res.body.contact).toBe(COMPANY_CONTACT);
  });

  test('contact and phone persist on re-read (stored field names unchanged)', async () => {
    const res = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    const individual = res.body.find(c => c.id === individualId);
    const company = res.body.find(c => c.id === companyId);
    expect(individual).toBeDefined();
    expect(company).toBeDefined();
    expect(individual.contact).toBe('');
    expect(individual.phone).toBe(PHONE);
    expect(company.contact).toBe(COMPANY_CONTACT);
    expect(company.phone).toBe(PHONE);
  });

  test('client name is still required', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'Individual', phone: PHONE });
    expect(res.statusCode).toBe(400);
  });

  test('unauthenticated client creation is refused', async () => {
    const res = await request(app)
      .post('/api/clients')
      .send({ name: 'LP-FIX10 No Auth' });
    expect(res.statusCode).toBe(401);
  });
});

describe('KYC / retainer modules and the post-create prompt workflows', () => {
  test('enabling kycCdd + retainerManagement does not break client creation', async () => {
    await setModules({ kycCdd: true, retainerManagement: true });
    const settings = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(settings.body.moduleSettings.kycCdd).toBe(true);
    expect(settings.body.moduleSettings.retainerManagement).toBe(true);

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `${INDIVIDUAL_NAME} (modules on)`, type: 'Individual' });
    expect(res.statusCode).toBe(200);
    await request(app).delete(`/api/clients/${res.body.id}`).set('Authorization', `Bearer ${adminToken}`);
  });

  test('Start KYC workflow exists: POST /api/client-kyc works for a new company client', async () => {
    // Mirrors the prompt button payload: clientId + not_started + category from type.
    const res = await request(app)
      .post('/api/client-kyc')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: companyId, status: 'not_started', clientCategory: 'company' });
    expect(res.statusCode).toBe(201);
    kycRecordId = res.body.id;
    expect(res.body.clientId).toBe(companyId);
    expect(res.body.status).toBe('not_started');
    expect(res.body.clientCategory).toBe('company');
  });

  test('Start retainer workflow exists: POST /api/retainers works for a new individual client', async () => {
    const res = await request(app)
      .post('/api/retainers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: individualId });
    expect(res.statusCode).toBe(201);
    retainerId = res.body.id;
    expect(res.body.clientId).toBe(individualId);
  });

  test('with modules disabled the workflows are refused and client creation still works', async () => {
    await setModules({ kycCdd: false, retainerManagement: false });

    const kycRes = await request(app)
      .post('/api/client-kyc')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: companyId, status: 'not_started' });
    expect(kycRes.statusCode).toBe(403);
    expect(kycRes.body.error).toBe('feature_disabled');

    const retainerRes = await request(app)
      .post('/api/retainers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: individualId });
    expect(retainerRes.statusCode).toBe(403);
    expect(retainerRes.body.error).toBe('feature_disabled');

    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `${COMPANY_NAME} (modules off)`, type: 'Company', contact: COMPANY_CONTACT });
    expect(clientRes.statusCode).toBe(200);
    await request(app).delete(`/api/clients/${clientRes.body.id}`).set('Authorization', `Bearer ${adminToken}`);

    // Re-enable for the remaining cleanup paths; afterAll restores the original state.
    await setModules({ kycCdd: true, retainerManagement: true });
  });
});

describe('matter creation (solDate name kept; Rate/Fee accepts typed strings)', () => {
  test('matter accepts solDate and a string billingRate as typed in the form', async () => {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'LP-FIX10 Matter',
        clientId: individualId,
        practiceArea: 'Civil Litigation',
        stage: 'Intake',
        solDate: '2026-09-30',
        billingType: 'hourly',
        billingRate: '75000',
        fixedFee: '',
      });
    expect(res.statusCode).toBe(200);
    matterId = res.body.id;
    expect(res.body.solDate).toBe('2026-09-30');
    expect(res.body.billingRate).toBe(75000);
    expect(res.body.fixedFee).toBe(0);
  });
});
