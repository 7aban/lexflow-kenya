const request = require('supertest');
const { app, dbReady } = require('../server.js');

// LOCAL-PILOT-FIX-12 is a frontend UX clarification of the Checklist Template
// Library (StaffViews/DocumentStudio). No backend behavior changed; this suite
// pins the existing checklist-template contract the redesigned UI relies on.
describe('LOCAL-PILOT-FIX-12 checklist template library regression guard', () => {
  const runId = Date.now();
  const password = 'Str0ng!Passw0rd2026!';
  let adminToken;
  let advocateToken;
  let assistantToken;
  let clientToken;
  let advocateName;
  let clientId;
  let matterId;
  let templateId;

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

    const clientEmail = `lpf12-client-${runId}@example.com`;
    const clientRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `LPF12 Client ${runId}`, email: clientEmail });
    expect(clientRes.statusCode).toBe(200);
    clientId = clientRes.body.id;

    const clientUserRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: clientEmail, password, fullName: `LPF12 Client User ${runId}`, role: 'client', clientId });
    expect(clientUserRes.statusCode).toBe(200);

    const clientLogin = await request(app)
      .post('/api/auth/client-login')
      .send({ email: clientEmail, password });
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;

    const matterRes = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, title: `LPF12 Matter ${runId}`, assignedTo: advocateName, practiceArea: 'Civil Litigation' });
    expect(matterRes.statusCode).toBe(200);
    matterId = matterRes.body.id;
  });

  test('admin can still create a template with checklist items', async () => {
    const res = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `LPF12 Civil suit filing checklist ${runId}`,
        description: 'Steps required to file a civil suit.',
        practiceArea: 'Civil Litigation',
        items: [
          { title: `Draft Plaint ${runId}`, notes: 'One clear action per item', position: 0 },
          { title: `File pleadings ${runId}`, position: 1 },
          { title: `Serve summons ${runId}`, position: 2 },
        ],
      });
    expect(res.statusCode).toBe(200);
    templateId = res.body.id;
    expect(res.body.active).toBe(1);
    expect(res.body.practiceArea).toBe('Civil Litigation');
    expect(res.body.items.map(item => item.title)).toEqual([
      `Draft Plaint ${runId}`,
      `File pleadings ${runId}`,
      `Serve summons ${runId}`,
    ]);
  });

  test('admin can still add an item to an existing template via PATCH', async () => {
    const res = await request(app)
      .patch(`/api/checklist-templates/${templateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          { title: `Draft Plaint ${runId}`, position: 0 },
          { title: `File pleadings ${runId}`, position: 1 },
          { title: `Serve summons ${runId}`, position: 2 },
          { title: `Fix mention date ${runId}`, position: 3 },
        ],
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(4);
    expect(res.body.items[3].title).toBe(`Fix mention date ${runId}`);
  });

  test('all staff roles can still list templates (UI list + Document Studio card)', async () => {
    for (const token of [adminToken, advocateToken, assistantToken]) {
      const res = await request(app)
        .get('/api/checklist-templates')
        .set('Authorization', `Bearer ${token}`);
      expect(res.statusCode).toBe(200);
      const template = res.body.find(item => item.id === templateId);
      expect(template).toBeDefined();
      expect(Array.isArray(template.items)).toBe(true);
      expect(template.items.length).toBe(4);
    }
  });

  test('advocate can still apply a template to an assigned matter', async () => {
    const res = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ templateId });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body.map(item => item.title)).toContain(`Serve summons ${runId}`);
    for (const item of res.body) {
      expect(item.matterId).toBe(matterId);
      expect(Number(item.completed || 0)).toBe(0);
    }
  });

  test('assistant cannot create, update, delete, or apply templates', async () => {
    const createRes = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ name: `LPF12 Assistant Template ${runId}`, items: [{ title: 'Step', position: 0 }] });
    expect(createRes.statusCode).toBe(403);

    const patchRes = await request(app)
      .patch(`/api/checklist-templates/${templateId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ name: 'Renamed' });
    expect(patchRes.statusCode).toBe(403);

    const deleteRes = await request(app)
      .delete(`/api/checklist-templates/${templateId}`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(deleteRes.statusCode).toBe(403);

    const applyRes = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ templateId });
    expect(applyRes.statusCode).toBe(403);
  });

  test('clients cannot list, create, or apply checklist templates', async () => {
    const listRes = await request(app)
      .get('/api/checklist-templates')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(listRes.statusCode).toBe(403);

    const createRes = await request(app)
      .post('/api/checklist-templates')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: `LPF12 Client Template ${runId}`, items: [{ title: 'Step', position: 0 }] });
    expect(createRes.statusCode).toBe(403);

    const applyRes = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ templateId });
    expect(applyRes.statusCode).toBe(403);
  });

  test('unauthenticated requests are rejected', async () => {
    const listRes = await request(app).get('/api/checklist-templates');
    expect(listRes.statusCode).toBe(401);

    const applyRes = await request(app)
      .post(`/api/matters/${matterId}/checklist-template-applications`)
      .send({ templateId });
    expect(applyRes.statusCode).toBe(401);
  });

  afterAll(async () => {
    if (templateId) {
      await request(app)
        .delete(`/api/checklist-templates/${templateId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });
});
