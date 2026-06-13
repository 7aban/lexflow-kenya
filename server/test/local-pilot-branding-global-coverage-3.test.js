const request = require('supertest');
const { app, dbReady } = require('../server.js');
const themeValidation = require('../lib/themeValidation');

const ADMIN = { email: 'admin@lexflow.co.ke', password: 'password123' };

function expectReadablePair(theme, foregroundKey, backgroundKey) {
  expect(theme[foregroundKey]).toBeDefined();
  expect(theme[backgroundKey]).toBeDefined();
  expect(themeValidation.contrastRatio(theme[foregroundKey], theme[backgroundKey])).toBeGreaterThanOrEqual(3);
}

describe('LOCAL-PILOT-BRANDING-GLOBAL-COVERAGE-3 theme coverage', () => {
  let adminToken;

  beforeAll(async () => {
    await dbReady;
    const login = await request(app).post('/api/auth/login').send(ADMIN);
    expect(login.statusCode).toBe(200);
    adminToken = login.body.token;
  });

  afterAll(async () => {
    if (adminToken) {
      await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
    }
  });

  test('default resolved theme includes readable foreground tokens', async () => {
    const reset = await request(app)
      .post('/api/firm-settings/theme/reset')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reset.statusCode).toBe(200);
    expect(reset.body.theme.primaryColor).toBe('#0F1B33');
    expect(reset.body.theme.accentColor).toBe('#D4A34A');
    expect(reset.body.theme.source).toBe('default');
    expectReadablePair(reset.body.theme, 'onSidebarColor', 'sidebarColor');
    expectReadablePair(reset.body.theme, 'onHeaderColor', 'headerColor');
    expectReadablePair(reset.body.theme, 'onButtonColor', 'buttonColor');
    expectReadablePair(reset.body.theme, 'cardTextColor', 'cardColor');
  });

  test('preset preview returns resolved readable tokens without persisting', async () => {
    const preset = themeValidation.getThemeById('emerald-gold');
    const preview = await request(app)
      .post('/api/firm-settings/theme/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(preset);

    expect(preview.statusCode).toBe(200);
    expect(preview.body.theme.primaryColor).toBe('#1B4332');
    expect(preview.body.theme.accentColor).toBe('#C9A227');
    expectReadablePair(preview.body.theme, 'textColor', 'backgroundColor');
    expectReadablePair(preview.body.theme, 'cardTextColor', 'cardColor');
    expectReadablePair(preview.body.theme, 'onAccentColor', 'accentColor');

    const current = await request(app)
      .get('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(current.statusCode).toBe(200);
    expect(current.body.theme.primaryColor).toBe('#0F1B33');
  });

  test('saving a preset persists readable helper tokens', async () => {
    const preset = themeValidation.getThemeById('midnight-slate');
    const saved = await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(preset);

    expect(saved.statusCode).toBe(200);
    expect(saved.body.theme.primaryColor).toBe('#1E293B');
    expectReadablePair(saved.body.theme, 'onSidebarColor', 'sidebarColor');
    expectReadablePair(saved.body.theme, 'cardMutedColor', 'cardColor');

    const current = await request(app)
      .get('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(current.statusCode).toBe(200);
    expect(current.body.theme.onSidebarColor).toBe(saved.body.theme.onSidebarColor);
  });

  test('reset restores the LexFlow default theme', async () => {
    const reset = await request(app)
      .post('/api/firm-settings/theme/reset')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reset.statusCode).toBe(200);
    expect(reset.body.message).toBe('Firm branding restored to LexFlow default.');
    expect(reset.body.theme.primaryColor).toBe('#0F1B33');
    expect(reset.body.theme.accentColor).toBe('#D4A34A');
    expect(reset.body.theme.source).toBe('default');
    expectReadablePair(reset.body.theme, 'onPrimaryColor', 'primaryColor');
  });

  test('unknown theme keys remain rejected', async () => {
    const res = await request(app)
      .post('/api/firm-settings/theme/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ primaryColor: '#0F1B33', unsupportedColor: '#FFFFFF' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Unknown theme key');
  });
});
