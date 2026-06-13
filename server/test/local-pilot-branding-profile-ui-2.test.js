const request = require('supertest');
const { app } = require('../server.js');
const themeValidation = require('../lib/themeValidation');

describe('Local Pilot: Brand Profile UI contract (v5.185)', () => {
  const defaultPrimary = '#0F1B33';
  const defaultAccent = '#D4A34A';
  let adminToken;
  let clientToken;

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;
    const clientRes = await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    clientToken = clientRes.body.token;
  });

  afterAll(async () => {
    if (adminToken) {
      await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
    }
  });

  test('preset preview accepts sanitized preset payload', async () => {
    const { id, ...presetPayload } = themeValidation.getThemeById('lexflow-default');

    const res = await request(app)
      .post('/api/firm-settings/theme/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(presetPayload);

    expect(id).toBe('lexflow-default');
    expect(res.statusCode).toBe(200);
    expect(res.body.theme.primaryColor).toBe(defaultPrimary);
    expect(res.body.theme.accentColor).toBe(defaultAccent);
    expect(res.body.theme.id).toBeUndefined();
  });

  test('reset returns resolved LexFlow defaults', async () => {
    await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        source: 'manual',
        primaryColor: '#1B4332',
        accentColor: '#C9A227',
        buttonColor: '#C9A227',
        buttonTextColor: '#1B4332',
      });

    const res = await request(app)
      .post('/api/firm-settings/theme/reset')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.theme).not.toBeNull();
    expect(res.body.theme.primaryColor).toBe(defaultPrimary);
    expect(res.body.theme.accentColor).toBe(defaultAccent);
    expect(res.body.theme.sidebarColor).toBeDefined();
    expect(res.body.theme.buttonColor).toBeDefined();
    expect(res.body.theme.backgroundColor).toBeDefined();
    expect(res.body.theme.source).toBe('default');
  });

  test('save/apply persists theme for later reads', async () => {
    const payload = {
      source: 'manual',
      primaryColor: '#1B4332',
      accentColor: '#C9A227',
      sidebarColor: '#1B4332',
      sidebarTextColor: '#E8E6DF',
      buttonColor: '#C9A227',
      buttonTextColor: '#1B4332',
    };

    const saveRes = await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);
    expect(saveRes.statusCode).toBe(200);

    const getRes = await request(app)
      .get('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.theme.primaryColor).toBe(payload.primaryColor);
    expect(getRes.body.theme.accentColor).toBe(payload.accentColor);
    expect(getRes.body.theme.buttonColor).toBe(payload.buttonColor);
  });

  test('firm settings write access remains protected', async () => {
    const unauthenticatedSettings = await request(app)
      .put('/api/firm-settings')
      .send({ name: 'Blocked Firm' });
    expect(unauthenticatedSettings.statusCode).toBe(401);

    const unauthenticatedPreview = await request(app)
      .post('/api/firm-settings/theme/preview')
      .send({ primaryColor: defaultPrimary });
    expect(unauthenticatedPreview.statusCode).toBe(401);

    const clientWrite = await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ primaryColor: defaultPrimary });
    expect(clientWrite.statusCode).toBe(403);
  });
});
