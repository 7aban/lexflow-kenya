// LOCAL-PILOT-FIX-11 — Kenyan matter stages + practice types.
//
// The stage localisation itself is frontend-only (KENYAN_MATTER_STAGES dropdown
// suggestions in client/src/views/StaffViews.jsx); matters.stage stays free text
// with no backend validation. This suite pins down the backend contract the new
// dropdowns rely on:
// 1. Kenyan litigation and non-litigation stage strings are accepted and persist
//    verbatim on create and update.
// 2. Legacy stage values (Discovery, Trial Prep, Active) remain accepted, so old
//    matters keep working and the "(legacy)" edit option can round-trip.
// 3. Closed/archived semantics are literal-string checks ('Closed', 'On Hold'):
//    the status route still defaults to 'Closed' and the client snapshot
//    activeCount treats Kenyan stages as active while excluding Closed/On Hold.
// 4. Client portal visibility keys off clientId, not stage — portal users see
//    matters with new Kenyan stage values.
const request = require('supertest');
const { app } = require('../server.js');

const CLIENT_NAME = 'LP-FIX11 Stage Client';
const PORTAL_EMAIL = 'lp-fix11-portal@test.lexflow.co.ke';
const PORTAL_PASSWORD = 'Portal11!stages';

let adminToken;
let clientToken;
let clientId;
const matterIds = [];

async function createMatter(payload) {
  const res = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ clientId, ...payload });
  if (res.body && res.body.id) matterIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = login.body.token;
  expect(adminToken).toBeDefined();

  const clientRes = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: CLIENT_NAME, type: 'Company' });
  expect(clientRes.statusCode).toBe(200);
  clientId = clientRes.body.id;

  const registerRes = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: PORTAL_EMAIL, password: PORTAL_PASSWORD, fullName: 'LP Fix11 Portal User', role: 'client', clientId });
  expect(registerRes.statusCode).toBe(200);
  const clientLogin = await request(app)
    .post('/api/auth/client-login')
    .send({ email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
  clientToken = clientLogin.body.token;
  expect(clientToken).toBeDefined();
});

afterAll(async () => {
  for (const id of matterIds) {
    await request(app).delete(`/api/matters/${id}`).set('Authorization', `Bearer ${adminToken}`);
  }
  if (clientId) {
    await request(app).delete(`/api/clients/${clientId}`).set('Authorization', `Bearer ${adminToken}`);
  }
});

describe('Kenyan stage values are accepted as free text', () => {
  test('litigation stage (Pleadings / Filing) persists verbatim', async () => {
    const res = await createMatter({ title: 'LP-FIX11 Litigation Matter', stage: 'Pleadings / Filing' });
    expect(res.statusCode).toBe(200);
    expect(res.body.stage).toBe('Pleadings / Filing');
    const read = await request(app).get(`/api/matters/${res.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(read.body.stage).toBe('Pleadings / Filing');
  });

  test('non-litigation stage (Conveyancing / Completion) persists verbatim', async () => {
    const res = await createMatter({ title: 'LP-FIX11 Conveyancing Matter', stage: 'Conveyancing / Completion', practiceArea: 'Conveyancing' });
    expect(res.statusCode).toBe(200);
    expect(res.body.stage).toBe('Conveyancing / Completion');
    expect(res.body.practiceArea).toBe('Conveyancing');
  });

  test('stage transitions across litigation flow via PATCH persist', async () => {
    const res = await createMatter({ title: 'LP-FIX11 Transition Matter', stage: 'Demand / Pre-action' });
    const id = res.body.id;
    for (const stage of ['Hearing', 'Ruling / Judgment', 'Execution / Enforcement']) {
      const patched = await request(app)
        .patch(`/api/matters/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ stage });
      expect(patched.statusCode).toBe(200);
      expect(patched.body.stage).toBe(stage);
    }
  });
});

describe('legacy stage values keep working', () => {
  test('old stage value (Discovery) is still accepted on create and update', async () => {
    const res = await createMatter({ title: 'LP-FIX11 Legacy Matter', stage: 'Discovery' });
    expect(res.statusCode).toBe(200);
    expect(res.body.stage).toBe('Discovery');
    const patched = await request(app)
      .patch(`/api/matters/${res.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ stage: 'Trial Prep' });
    expect(patched.statusCode).toBe(200);
    expect(patched.body.stage).toBe('Trial Prep');
  });

  test('omitting stage still defaults to Intake', async () => {
    const res = await createMatter({ title: 'LP-FIX11 Default Stage Matter' });
    expect(res.statusCode).toBe(200);
    expect(res.body.stage).toBe('Intake');
  });
});

describe('closed/archived semantics unchanged', () => {
  test('status route still defaults to the literal Closed value', async () => {
    const res = await createMatter({ title: 'LP-FIX11 Archive Matter', stage: 'Hearing' });
    const id = res.body.id;
    const archived = await request(app)
      .patch(`/api/matters/${id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(archived.statusCode).toBe(200);
    const read = await request(app).get(`/api/matters/${id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(read.body.stage).toBe('Closed');
  });

  test('snapshot activeCount counts Kenyan stages as active and excludes Closed/On Hold', async () => {
    // At this point the suite has created: Pleadings / Filing, Conveyancing /
    // Completion, Execution / Enforcement, Trial Prep, Intake (active) and one
    // Closed. Add an On Hold matter to cover both excluded literals.
    const onHold = await createMatter({ title: 'LP-FIX11 On Hold Matter', stage: 'On Hold' });
    expect(onHold.statusCode).toBe(200);
    const snap = await request(app)
      .get(`/api/clients/${clientId}/snapshot`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(snap.statusCode).toBe(200);
    expect(snap.body.matters.totalCount).toBe(7);
    expect(snap.body.matters.activeCount).toBe(5);
  });
});

describe('client portal visibility is stage-agnostic', () => {
  test('portal user sees matters with Kenyan stage values', async () => {
    const res = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    const stages = res.body.map(m => m.stage);
    expect(stages).toContain('Pleadings / Filing');
    expect(stages).toContain('Conveyancing / Completion');
    expect(stages).toContain('On Hold');
    expect(stages).toContain('Closed');
  });

  test('portal user still cannot create or restage matters', async () => {
    const create = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ clientId, title: 'LP-FIX11 Portal Create', stage: 'Hearing' });
    expect(create.statusCode).toBe(403);
    const patch = await request(app)
      .patch(`/api/matters/${matterIds[0]}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ stage: 'Closed' });
    expect(patch.statusCode).toBe(403);
  });
});
