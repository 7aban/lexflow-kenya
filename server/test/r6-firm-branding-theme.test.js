const request = require('supertest');
const { app } = require('../server.js');
const themeValidation = require('../lib/themeValidation');

describe('R6: Firm Branding/Theme System', () => {
  let adminToken;
  let advocateToken;
  let clientToken;

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;
    const advRes = await request(app).post('/api/auth/login').send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    advocateToken = advRes.body.token;
    const clientRes = await request(app).post('/api/auth/client-login').send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    clientToken = clientRes.body.token;
  });

  describe('Theme Validation Library', () => {
    describe('normalizeHexColor', () => {
      test('normalizes #RGB to #RRGGBB', () => {
        expect(themeValidation.normalizeHexColor('#ABC')).toBe('#AABBCC');
        expect(themeValidation.normalizeHexColor('#fff')).toBe('#FFFFFF');
        expect(themeValidation.normalizeHexColor('#f0f')).toBe('#FF00FF');
      });
      test('normalizes #RRGGBB to uppercase', () => {
        expect(themeValidation.normalizeHexColor('#aabbcc')).toBe('#AABBCC');
        expect(themeValidation.normalizeHexColor('#C5973C')).toBe('#C5973C');
      });
      test('trims whitespace', () => {
        expect(themeValidation.normalizeHexColor('  #ABC  ')).toBe('#AABBCC');
      });
      test('rejects invalid formats', () => {
        expect(themeValidation.normalizeHexColor('rgb(255,0,0)')).toBeNull();
        expect(themeValidation.normalizeHexColor('hsl(120,100%,50%)')).toBeNull();
        expect(themeValidation.normalizeHexColor('red')).toBeNull();
        expect(themeValidation.normalizeHexColor('#GGG')).toBeNull();
        expect(themeValidation.normalizeHexColor('#12345')).toBeNull();
        expect(themeValidation.normalizeHexColor('')).toBeNull();
        expect(themeValidation.normalizeHexColor(null)).toBeNull();
        expect(themeValidation.normalizeHexColor(undefined)).toBeNull();
      });
    });

    describe('contrastRatio', () => {
      test('black on white is 21:1', () => {
        expect(themeValidation.contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
      });
      test('white on white is 1:1', () => {
        expect(themeValidation.contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 0);
      });
      test('emerald gold preset text/background exceeds 3:1', () => {
        const ratio = themeValidation.contrastRatio('#E8E6DF', '#0D1F17');
        expect(ratio).toBeGreaterThan(3.0);
      });
      test('similar colors produce low contrast', () => {
        const ratio = themeValidation.contrastRatio('#333333', '#444444');
        expect(ratio).toBeLessThan(3.0);
      });
    });

    describe('validateThemeInput', () => {
      test('accepts valid minimal theme', () => {
        const result = themeValidation.validateThemeInput({ primaryColor: '#1A3628', accentColor: '#C5973C' });
        expect(result.error).toBeUndefined();
        expect(result.value.primaryColor).toBe('#1A3628');
        expect(result.value.accentColor).toBe('#C5973C');
      });
      test('accepts full valid theme', () => {
        const theme = {
          source: 'manual',
          primaryColor: '#1A3628',
          accentColor: '#C5973C',
          backgroundColor: '#0A0F1A',
          surfaceColor: '#111827',
          textColor: '#E5E7EB',
          textSecondaryColor: '#9CA3AF',
          sidebarColor: '#1A3628',
          sidebarTextColor: '#E5E7EB',
          buttonColor: '#C5973C',
          buttonTextColor: '#1A3628',
          borderColor: '#1F2937',
          linkColor: '#C5973C',
          headerColor: '#1A3628',
          headerTextColor: '#E5E7EB',
          footerColor: '#0A0F1A',
          footerTextColor: '#9CA3AF',
          cardColor: '#111827',
          cardBorderColor: '#1F2937',
        };
        const result = themeValidation.validateThemeInput(theme);
        expect(result.error).toBeUndefined();
      });
      test('normalizes #RGB to #RRGGBB uppercase', () => {
        const result = themeValidation.validateThemeInput({ primaryColor: '#abc' });
        expect(result.error).toBeUndefined();
        expect(result.value.primaryColor).toBe('#AABBCC');
      });
      test('rejects rgb() format', () => {
        const result = themeValidation.validateThemeInput({ primaryColor: 'rgb(255,0,0)' });
        expect(result.error).toContain('only #RGB or #RRGGBB hex allowed');
      });
      test('rejects hsl() format', () => {
        const result = themeValidation.validateThemeInput({ primaryColor: 'hsl(120,100%,50%)' });
        expect(result.error).toContain('only #RGB or #RRGGBB hex allowed');
      });
      test('rejects named colors', () => {
        const result = themeValidation.validateThemeInput({ primaryColor: 'red' });
        expect(result.error).toContain('only #RGB or #RRGGBB hex allowed');
      });
      test('rejects var() CSS variables', () => {
        const result = themeValidation.validateThemeInput({ primaryColor: 'var(--primary)' });
        expect(result.error).toContain('only #RGB or #RRGGBB hex allowed');
      });
      test('rejects unknown theme keys', () => {
        const result = themeValidation.validateThemeInput({ customCss: 'body { color: red; }' });
        expect(result.error).toContain('Unknown theme key');
      });
      test('rejects raw CSS injection attempts', () => {
        const result = themeValidation.validateThemeInput({ primaryColor: '#000; background: url(evil.com)' });
        expect(result.error).toContain('only #RGB or #RRGGBB hex allowed');
      });
      test('rejects non-object input', () => {
        expect(themeValidation.validateThemeInput('string').error).toBeDefined();
        expect(themeValidation.validateThemeInput(null).error).toBeDefined();
        expect(themeValidation.validateThemeInput([]).error).toBeDefined();
        expect(themeValidation.validateThemeInput(123).error).toBeDefined();
      });
      test('rejects oversized JSON', () => {
        const theme = { logo: 'https://example.com/' + 'x'.repeat(2000) };
        const result = themeValidation.validateThemeInput(theme);
        expect(result.error).toContain('exceeds');
      });
      test('validates source enum', () => {
        expect(themeValidation.validateThemeInput({ source: 'manual' }).error).toBeUndefined();
        expect(themeValidation.validateThemeInput({ source: 'preset' }).error).toBeUndefined();
        expect(themeValidation.validateThemeInput({ source: 'default' }).error).toBeUndefined();
        expect(themeValidation.validateThemeInput({ source: 'invalid' }).error).toContain('Invalid source');
      });
      test('validates logo URL length', () => {
        const result = themeValidation.validateThemeInput({ logo: 'data:image/png;base64,' + 'x'.repeat(5001) });
        expect(result.error).toContain('exceeds 5000 character limit');
      });
      test('silently drops id key (preset convenience)', () => {
        const result = themeValidation.validateThemeInput({ id: 'emerald-gold', primaryColor: '#1B4332' });
        expect(result.error).toBeUndefined();
        expect(result.value.id).toBeUndefined();
        expect(result.value.primaryColor).toBe('#1B4332');
      });
      test('silently drops theme key', () => {
        const result = themeValidation.validateThemeInput({ theme: { nested: true }, primaryColor: '#1A3628' });
        expect(result.error).toBeUndefined();
        expect(result.value.theme).toBeUndefined();
      });
    });

    describe('validateThemeAccessibility', () => {
      test('emerald-gold preset passes minimum contrast', () => {
        const theme = {
          textColor: '#E8E6DF',
          backgroundColor: '#0D1F17',
          buttonTextColor: '#1B4332',
          buttonColor: '#C9A227',
          sidebarTextColor: '#E8E6DF',
          sidebarColor: '#1B4332',
        };
        const { warnings, blocks } = themeValidation.validateThemeAccessibility(theme);
        expect(blocks).toEqual([]);
      });
      test('low contrast pair produces block', () => {
        const theme = {
          textColor: '#333333',
          backgroundColor: '#444444',
        };
        const { blocks } = themeValidation.validateThemeAccessibility(theme);
        expect(blocks.length).toBeGreaterThan(0);
      });
      test('borderline contrast produces warning not block', () => {
        const theme = {
          textColor: '#767676',
          backgroundColor: '#FFFFFF',
        };
        const { warnings, blocks } = themeValidation.validateThemeAccessibility(theme);
        expect(blocks).toEqual([]);
      });
    });

    describe('getPresets', () => {
      test('returns array of presets with ids', () => {
        const presets = themeValidation.getPresets();
        expect(Array.isArray(presets)).toBe(true);
        expect(presets.length).toBeGreaterThan(0);
        expect(presets[0].id).toBeDefined();
      });
      test('includes lexflow-default preset', () => {
        const presets = themeValidation.getPresets();
        const found = presets.find(p => p.id === 'lexflow-default');
        expect(found).toBeDefined();
        expect(found.primaryColor).toBe('#1A3628');
      });
      test('includes emerald-gold preset', () => {
        const presets = themeValidation.getPresets();
        const found = presets.find(p => p.id === 'emerald-gold');
        expect(found).toBeDefined();
        expect(found.primaryColor).toBe('#1B4332');
        expect(found.accentColor).toBe('#C9A227');
      });
    });

    describe('getThemeById', () => {
      test('returns preset by id', () => {
        const theme = themeValidation.getThemeById('lexflow-default');
        expect(theme).not.toBeNull();
        expect(theme.id).toBe('lexflow-default');
      });
      test('returns null for unknown id', () => {
        expect(themeValidation.getThemeById('nonexistent')).toBeNull();
      });
    });
  });

  describe('Theme API Endpoints', () => {
    describe('GET /api/firm-settings/theme', () => {
      test('returns theme for authenticated users', async () => {
        const res = await request(app).get('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('theme');
      });
      test('client can read theme', async () => {
        const res = await request(app).get('/api/firm-settings/theme').set('Authorization', `Bearer ${clientToken}`);
        expect(res.statusCode).toBe(200);
      });
      test('requires authentication', async () => {
        const res = await request(app).get('/api/firm-settings/theme');
        expect(res.statusCode).toBe(401);
      });
    });

    describe('POST /api/firm-settings/theme/preview', () => {
      test('valid theme returns preview with no blocks', async () => {
        const res = await request(app)
          .post('/api/firm-settings/theme/preview')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ primaryColor: '#1A3628', accentColor: '#C5973C', backgroundColor: '#0A0F1A', textColor: '#E5E7EB' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('theme');
        expect(res.body).toHaveProperty('warnings');
        expect(res.body).toHaveProperty('blocks');
      });
      test('low contrast theme returns 400 with blocks', async () => {
        const res = await request(app)
          .post('/api/firm-settings/theme/preview')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ textColor: '#333333', backgroundColor: '#444444' });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe('Theme blocked');
        expect(res.body.details.length).toBeGreaterThan(0);
      });
      test('invalid color format returns 400', async () => {
        const res = await request(app)
          .post('/api/firm-settings/theme/preview')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ primaryColor: 'rgb(255,0,0)' });
        expect(res.statusCode).toBe(400);
      });
      test('requires admin role', async () => {
        const res = await request(app)
          .post('/api/firm-settings/theme/preview')
          .set('Authorization', `Bearer ${clientToken}`)
          .send({ primaryColor: '#1A3628' });
        expect(res.statusCode).toBe(403);
      });
      test('accepts preset payload with id key (frontend convenience)', async () => {
        const res = await request(app)
          .post('/api/firm-settings/theme/preview')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ id: 'lexflow-default', primaryColor: '#1A3628', accentColor: '#C5973C', source: 'preset' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('theme');
      });
    });

    describe('PUT /api/firm-settings/theme', () => {
      test('admin can update theme', async () => {
        const theme = {
          source: 'manual',
          primaryColor: '#1B4332',
          accentColor: '#C9A227',
          backgroundColor: '#0D1F17',
          textColor: '#E8E6DF',
          sidebarColor: '#1B4332',
          sidebarTextColor: '#E8E6DF',
          buttonColor: '#C9A227',
          buttonTextColor: '#1B4332',
        };
        const res = await request(app)
          .put('/api/firm-settings/theme')
          .set('Authorization', `Bearer ${adminToken}`)
          .send(theme);
        expect(res.statusCode).toBe(200);
        expect(res.body.theme.primaryColor).toBe('#1B4332');
      });
      test('persisted theme is returned on GET', async () => {
        const theme = { source: 'manual', primaryColor: '#1A3628', accentColor: '#C5973C', backgroundColor: '#0A0F1A', textColor: '#E5E7EB', buttonColor: '#C5973C', buttonTextColor: '#1A3628', sidebarColor: '#1A3628', sidebarTextColor: '#E5E7EB' };
        await request(app).put('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`).send(theme);
        const getRes = await request(app).get('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`);
        expect(getRes.body.theme).not.toBeNull();
        expect(getRes.body.theme.primaryColor).toBe('#1A3628');
      });
      test('requires admin role', async () => {
        const res = await request(app)
          .put('/api/firm-settings/theme')
          .set('Authorization', `Bearer ${clientToken}`)
          .send({ primaryColor: '#1A3628' });
        expect(res.statusCode).toBe(403);
      });
      test('rejects invalid input', async () => {
        const res = await request(app)
          .put('/api/firm-settings/theme')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ primaryColor: 'invalid' });
        expect(res.statusCode).toBe(400);
      });
    });

    describe('POST /api/firm-settings/theme/reset', () => {
      test('admin can reset theme', async () => {
        await request(app).put('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`).send({ source: 'manual', primaryColor: '#1A3628', accentColor: '#C5973C', backgroundColor: '#0A0F1A', textColor: '#E5E7EB', buttonColor: '#C5973C', buttonTextColor: '#1A3628', sidebarColor: '#1A3628', sidebarTextColor: '#E5E7EB' });
        const res = await request(app)
          .post('/api/firm-settings/theme/reset')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.theme).not.toBeNull();
        expect(res.body.theme.primaryColor).toBe('#1A3628');
        expect(res.body.theme.accentColor).toBe('#C5973C');
        expect(res.body.message).toBe('Firm branding restored to LexFlow default.');
      });
      test('theme is resolved after reset (not null)', async () => {
        await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
        const getRes = await request(app).get('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`);
        expect(getRes.body.theme).not.toBeNull();
        expect(getRes.body.theme.primaryColor).toBe('#1A3628');
        expect(getRes.body.theme.accentColor).toBe('#C5973C');
      });
      test('requires admin role', async () => {
        const res = await request(app)
          .post('/api/firm-settings/theme/reset')
          .set('Authorization', `Bearer ${clientToken}`);
        expect(res.statusCode).toBe(403);
      });
    });

    describe('GET /api/firm-settings/theme/presets', () => {
      test('returns presets list', async () => {
        const res = await request(app).get('/api/firm-settings/theme/presets').set('Authorization', `Bearer ${adminToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.presets).toBeDefined();
        expect(res.body.presets.length).toBeGreaterThan(0);
      });
      test('client can view presets', async () => {
        const res = await request(app).get('/api/firm-settings/theme/presets').set('Authorization', `Bearer ${clientToken}`);
        expect(res.statusCode).toBe(200);
      });
      test('presets include required fields', async () => {
        const res = await request(app).get('/api/firm-settings/theme/presets').set('Authorization', `Bearer ${adminToken}`);
        const preset = res.body.presets.find(p => p.id === 'lexflow-default');
        expect(preset).toBeDefined();
        expect(preset.primaryColor).toBeDefined();
        expect(preset.accentColor).toBeDefined();
      });
    });

    describe('Audit events', () => {
      test('firm_theme_updated event is recorded', async () => {
        const theme = { source: 'manual', primaryColor: '#1A3628', accentColor: '#C5973C', backgroundColor: '#0A0F1A', textColor: '#E5E7EB', buttonColor: '#C5973C', buttonTextColor: '#1A3628', sidebarColor: '#1A3628', sidebarTextColor: '#E5E7EB' };
        await request(app).put('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`).send(theme);
        const res = await request(app)
          .get('/api/audit-events?action=firm_theme_updated')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.statusCode).toBe(200);
        const updatedEvents = res.body.rows.filter(e => e.action === 'firm_theme_updated');
        expect(updatedEvents.length).toBeGreaterThan(0);
      });
      test('firm_theme_reset event is recorded', async () => {
        await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
        const res = await request(app)
          .get('/api/audit-events?action=firm_theme_reset')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.statusCode).toBe(200);
        const resetEvents = res.body.rows.filter(e => e.action === 'firm_theme_reset');
        expect(resetEvents.length).toBeGreaterThan(0);
      });
    });
  });

  describe('getFirmSettings includes theme', () => {
    test('theme is included in firm settings', async () => {
      const theme = { source: 'manual', primaryColor: '#1A3628', accentColor: '#C5973C', backgroundColor: '#0A0F1A', textColor: '#E5E7EB', buttonColor: '#C5973C', buttonTextColor: '#1A3628', sidebarColor: '#1A3628', sidebarTextColor: '#E5E7EB' };
      await request(app).put('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`).send(theme);
      const res = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.theme).not.toBeNull();
      expect(res.body.theme.primaryColor).toBe('#1A3628');
    });
    test('theme is resolved when not set (not null)', async () => {
      await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
      const res = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.theme).not.toBeNull();
      expect(res.body.theme.primaryColor).toBe('#1A3628');
      expect(res.body.theme.accentColor).toBe('#C5973C');
    });
  });
});
