const request = require('supertest');
const { app, dbReady } = require('../server.js');

const ADMIN = { email: 'admin@lexflow.co.ke', password: 'password123' };
const DEFAULT_PRIMARY = '#1A3628';
const DEFAULT_ACCENT = '#C5973C';
const DEFAULT_BACKGROUND = '#F5F2EB';
const DEFAULT_SIDEBAR = '#112219';
const DEFAULT_BORDER = '#DDD8CE';
const TEST_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const PUBLIC_BRANDING_KEYS = ['accentColor', 'appName', 'displayName', 'firmName', 'logo', 'name', 'poweredBy', 'primaryColor', 'productName', 'theme'];
const PRIVATE_FIRM_SETTINGS_KEYS = [
  'id',
  'websiteURL',
  'email',
  'phone',
  'address',
  'paymentInstructions',
  'kraPin',
  'vatNumber',
  'invoiceFooterNote',
  'defaultInvoiceDueDays',
  'reminderSettings',
  'moduleSettings',
  'advocateBillingVisibility',
];

describe('LOCAL-PILOT-BRANDING-CORRECTION-5 theme and logo contract', () => {
  let adminToken;
  let originalSettings;

  beforeAll(async () => {
    await dbReady;
    const login = await request(app).post('/api/auth/login').send(ADMIN);
    expect(login.statusCode).toBe(200);
    adminToken = login.body.token;
    const current = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    originalSettings = current.body || {};
  });

  afterAll(async () => {
    if (!adminToken) return;
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ...originalSettings,
        logo: originalSettings?.logo || '',
        primaryColor: DEFAULT_PRIMARY,
        accentColor: DEFAULT_ACCENT,
      });
    await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
  });

  test('public branding endpoint returns only safe default branding fields', async () => {
    await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);

    const publicBranding = await request(app).get('/api/public/branding');

    expect(publicBranding.statusCode).toBe(200);
    expect(Object.keys(publicBranding.body).sort()).toEqual(PUBLIC_BRANDING_KEYS.sort());
    expect(publicBranding.body.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(publicBranding.body.accentColor).toBe(DEFAULT_ACCENT);
    expect(publicBranding.body.theme.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(publicBranding.body.theme.accentColor).toBe(DEFAULT_ACCENT);
    expect(publicBranding.body.theme.backgroundColor).toBe(DEFAULT_BACKGROUND);
    expect(publicBranding.body.theme.sidebarColor).toBe(DEFAULT_SIDEBAR);
    expect(publicBranding.body.poweredBy).toBe('LexFlow');
    for (const key of PRIVATE_FIRM_SETTINGS_KEYS) {
      expect(publicBranding.body).not.toHaveProperty(key);
      expect(publicBranding.body.theme).not.toHaveProperty(key);
    }
  });

  test('unauthenticated full firm settings no longer expose private settings', async () => {
    const unauthenticated = await request(app).get('/api/firm-settings');

    expect([401, 403]).toContain(unauthenticated.statusCode);
    for (const key of PRIVATE_FIRM_SETTINGS_KEYS) {
      expect(unauthenticated.body).not.toHaveProperty(key);
    }
  });

  test('authenticated firm settings behavior remains available', async () => {
    const authenticated = await request(app)
      .get('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.body.email).toBeDefined();
    expect(authenticated.body.reminderSettings).toBeDefined();
    expect(authenticated.body.moduleSettings).toBeDefined();
    expect(authenticated.body.theme.primaryColor).toBeDefined();
  });

  test('legacy saved LexFlow default colours resolve to the corrected public default', async () => {
    await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
    const firm = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(firm.statusCode).toBe(200);

    const legacySave = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...firm.body, primaryColor: '#0F1B33', accentColor: '#D4A34A' });

    expect(legacySave.statusCode).toBe(200);
    expect(legacySave.body.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(legacySave.body.accentColor).toBe(DEFAULT_ACCENT);

    const publicBranding = await request(app).get('/api/public/branding');
    expect(publicBranding.statusCode).toBe(200);
    expect(publicBranding.body.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(publicBranding.body.accentColor).toBe(DEFAULT_ACCENT);
    expect(publicBranding.body.theme.sidebarColor).toBe(DEFAULT_SIDEBAR);
  });

  test('reset restores the UI-reference LexFlow default colours', async () => {
    await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source: 'manual', primaryColor: '#123456', accentColor: '#AA7733' });

    const reset = await request(app)
      .post('/api/firm-settings/theme/reset')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reset.statusCode).toBe(200);
    expect(reset.body.theme.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(reset.body.theme.accentColor).toBe(DEFAULT_ACCENT);
    expect(reset.body.theme.source).toBe('default');
  });

  test('resolved default theme includes forest, gold, cream, and legal-office tokens', async () => {
    await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);

    const current = await request(app)
      .get('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(current.statusCode).toBe(200);
    expect(current.body.theme.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(current.body.theme.accentColor).toBe(DEFAULT_ACCENT);
    expect(current.body.theme.backgroundColor).toBe(DEFAULT_BACKGROUND);
    expect(current.body.theme.sidebarColor).toBe(DEFAULT_SIDEBAR);
    expect(current.body.theme.headerColor).toBe(DEFAULT_PRIMARY);
    expect(current.body.theme.cardColor).toBe('#FFFFFF');
    expect(current.body.theme.cardBorderColor).toBe(DEFAULT_BORDER);
    expect(current.body.theme.textColor).toBe('#1A1A18');
  });

  test('saving custom primary and accent colours still works', async () => {
    const custom = {
      source: 'manual',
      primaryColor: '#123456',
      accentColor: '#C48A2C',
      sidebarColor: '#123456',
      headerColor: '#123456',
      buttonColor: '#123456',
      linkColor: '#C48A2C',
    };

    const save = await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(custom);

    expect(save.statusCode).toBe(200);
    expect(save.body.theme.primaryColor).toBe(custom.primaryColor);
    expect(save.body.theme.accentColor).toBe(custom.accentColor);

    const publicBranding = await request(app).get('/api/public/branding');
    expect(publicBranding.statusCode).toBe(200);
    expect(publicBranding.body.primaryColor).toBe(custom.primaryColor);
    expect(publicBranding.body.accentColor).toBe(custom.accentColor);
  });

  test('logo save remains compatible and theme reset preserves the logo', async () => {
    const firm = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(firm.statusCode).toBe(200);

    const saveLogo = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...firm.body, logo: TEST_LOGO, primaryColor: '#123456', accentColor: '#C48A2C' });

    expect(saveLogo.statusCode).toBe(200);
    expect(saveLogo.body.logo).toBe(TEST_LOGO);

    const reset = await request(app)
      .post('/api/firm-settings/theme/reset')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reset.statusCode).toBe(200);

    const afterReset = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(afterReset.statusCode).toBe(200);
    expect(afterReset.body.logo).toBe(TEST_LOGO);
    expect(afterReset.body.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(afterReset.body.accentColor).toBe(DEFAULT_ACCENT);
  });

  test('invalid theme keys are still rejected safely', async () => {
    const preview = await request(app)
      .post('/api/firm-settings/theme/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        primaryColor: DEFAULT_PRIMARY,
        accentColor: DEFAULT_ACCENT,
        extractedPixels: 300,
      });

    expect(preview.statusCode).toBe(400);
    expect(preview.body.error).toContain('Unknown theme key');
  });
});
