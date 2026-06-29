const request = require('supertest');
const { app } = require('../server.js');

describe('Local Pilot: Branding Reset & Theme Foundation (v5.183)', () => {
  const LEXFLOW_DEFAULT_PRIMARY = '#1A3628';
  const LEXFLOW_DEFAULT_ACCENT = '#C5973C';
  let adminToken;

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;
  });

  describe('POST /api/firm-settings/theme/reset', () => {
    test('restores legacy primaryColor and accentColor defaults in DB', async () => {
      await request(app).put('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`)
        .send({ primaryColor: '#999999', accentColor: '#888888' });
      await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
      const settings = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
      expect(settings.body.primaryColor).toBe(LEXFLOW_DEFAULT_PRIMARY);
      expect(settings.body.accentColor).toBe(LEXFLOW_DEFAULT_ACCENT);
    });

    test('returns fully resolved theme object with all surface tokens', async () => {
      const res = await request(app)
        .post('/api/firm-settings/theme/reset')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.theme).not.toBeNull();
      const t = res.body.theme;
      expect(t.primaryColor).toBe(LEXFLOW_DEFAULT_PRIMARY);
      expect(t.accentColor).toBe(LEXFLOW_DEFAULT_ACCENT);
      expect(t.sidebarColor).toBeDefined();
      expect(t.sidebarTextColor).toBeDefined();
      expect(t.buttonColor).toBeDefined();
      expect(t.buttonTextColor).toBeDefined();
      expect(t.backgroundColor).toBeDefined();
      expect(t.surfaceColor).toBeDefined();
      expect(t.textColor).toBeDefined();
      expect(t.textSecondaryColor).toBeDefined();
      expect(t.borderColor).toBeDefined();
      expect(t.linkColor).toBeDefined();
      expect(t.cardColor).toBeDefined();
      expect(t.cardBorderColor).toBeDefined();
      expect(t.headerColor).toBeDefined();
      expect(t.headerTextColor).toBeDefined();
      expect(t.successColor).toBeDefined();
      expect(t.warningColor).toBeDefined();
      expect(t.errorColor).toBeDefined();
      expect(t.infoColor).toBeDefined();
      expect(t.source).toBe('default');
    });

    test('message confirms full restoration', async () => {
      const res = await request(app)
        .post('/api/firm-settings/theme/reset')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.message).toBe('Firm branding restored to LexFlow default.');
    });
  });

  describe('GET /api/firm-settings/theme (resolved fallback)', () => {
    test('returns resolved theme when themeJson is null', async () => {
      await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
      const res = await request(app).get('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.theme).not.toBeNull();
      expect(res.body.theme.primaryColor).toBe(LEXFLOW_DEFAULT_PRIMARY);
    });

    test('falls back to legacy primaryColor when themeJson is absent', async () => {
      await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
      const res = await request(app).get('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.theme.primaryColor).toBe(LEXFLOW_DEFAULT_PRIMARY);
      expect(res.body.theme.accentColor).toBe(LEXFLOW_DEFAULT_ACCENT);
    });
  });
});
