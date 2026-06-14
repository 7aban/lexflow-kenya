const request = require('supertest');
const { app, dbReady } = require('../server.js');

const ADMIN = { email: 'admin@lexflow.co.ke', password: 'password123' };
const CLIENT = { email: 'margaret.wairimu@example.co.ke', password: 'password123' };
const defaultPrimary = '#0F1B33';
const defaultAccent = '#D4A34A';

describe('LOCAL-PILOT-BRANDING-SMART-PALETTE-4 theme API contract', () => {
  let adminToken;
  let clientToken;

  beforeAll(async () => {
    await dbReady;
    const adminLogin = await request(app).post('/api/auth/login').send(ADMIN);
    expect(adminLogin.statusCode).toBe(200);
    adminToken = adminLogin.body.token;

    const clientLogin = await request(app).post('/api/auth/client-login').send(CLIENT);
    expect(clientLogin.statusCode).toBe(200);
    clientToken = clientLogin.body.token;
  });

  afterAll(async () => {
    if (adminToken) {
      await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
    }
  });

  test('saving a suggested palette persists as normal manual theme values', async () => {
    const suggestedPalette = {
      source: 'manual',
      primaryColor: '#123456',
      accentColor: '#C48A2C',
      sidebarColor: '#123456',
      sidebarTextColor: '#FFFFFF',
      buttonColor: '#C48A2C',
      buttonTextColor: '#101827',
      linkColor: '#C48A2C',
    };

    const save = await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(suggestedPalette);

    expect(save.statusCode).toBe(200);
    expect(save.body.theme.primaryColor).toBe(suggestedPalette.primaryColor);
    expect(save.body.theme.accentColor).toBe(suggestedPalette.accentColor);

    const current = await request(app)
      .get('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(current.statusCode).toBe(200);
    expect(current.body.theme.primaryColor).toBe(suggestedPalette.primaryColor);
    expect(current.body.theme.accentColor).toBe(suggestedPalette.accentColor);
  });

  test('reset still restores the LexFlow default palette', async () => {
    const reset = await request(app)
      .post('/api/firm-settings/theme/reset')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reset.statusCode).toBe(200);
    expect(reset.body.theme.primaryColor).toBe(defaultPrimary);
    expect(reset.body.theme.accentColor).toBe(defaultAccent);
    expect(reset.body.theme.source).toBe('default');
  });

  test('invalid smart palette payload keys remain rejected', async () => {
    const preview = await request(app)
      .post('/api/firm-settings/theme/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        primaryColor: '#123456',
        accentColor: '#C48A2C',
        extractedPixels: 240,
      });

    expect(preview.statusCode).toBe(400);
    expect(preview.body.error).toContain('Unknown theme key');
  });

  test('theme write access remains admin-only', async () => {
    const unauthenticated = await request(app)
      .put('/api/firm-settings/theme')
      .send({ primaryColor: defaultPrimary, accentColor: defaultAccent });

    expect(unauthenticated.statusCode).toBe(401);

    const clientWrite = await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ primaryColor: defaultPrimary, accentColor: defaultAccent });

    expect(clientWrite.statusCode).toBe(403);
  });
});
